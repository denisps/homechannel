# Testing Guide

## Overview

HomeChannel has comprehensive test coverage across multiple levels:
- **Unit Tests**: Test individual components in isolation
- **Integration Tests**: Test interactions between components
- **E2E Tests**: Test complete flows from start to finish
- **System Tests**: Test system-level properties like concurrency and scalability

## Test Structure

```
homechannel/
├── shared/test/          # Crypto and protocol unit tests
├── coordinator/test/     # Coordinator unit and integration tests
├── server/test/          # Server unit and integration tests  
├── client/test/          # Client unit tests
└── tests/                # E2E and system tests
    ├── e2e/             # End-to-end tests
    ├── integration/     # Cross-component integration tests
    ├── system/          # System-level tests
    └── utils/           # Test helpers
```

## Running Tests

### Component Tests

Run tests for individual components:

```bash
# Shared crypto/protocol tests
cd shared && npm test

# Coordinator tests
cd coordinator && npm test

# Server tests (unit and services)
cd server && npm test

# Server WebRTC connectivity tests (optional, requires WebRTC library)
cd server && npm run test:webrtc

# Client tests
cd client && npm test
```

### E2E and System Tests

Run end-to-end and system tests:

```bash
cd tests

# All tests
npm test

# Just integration tests
npm run test:integration

# Just e2e tests
npm run test:e2e

# Just system tests
npm run test:system
```

## Test Categories

### Unit Tests

Unit tests validate individual functions and classes in isolation:

- **shared/test/crypto.test.js**: Crypto primitives (AES-GCM, Ed25519/Ed448, X25519/X448)
- **shared/test/protocol.test.js**: Protocol message encoding/decoding
- **coordinator/test/coordinator.test.js**: Registry and UDP protocol handling
- **coordinator/test/https.test.js**: HTTPS endpoints
- **server/test/services.test.js**: File app operations (migration in progress)
- **server/test/webrtc.test.js**: WebRTC library abstraction
- **client/test/client.test.js**: Client API and WebRTC handling
- **client/test/filebrowser.test.js**: File app UI validation (migration in progress)

**Characteristics:**
- Fast execution (< 3 seconds per suite)
- No external dependencies
- Mock implementations where needed
- Focused on single responsibility

### Integration Tests

Integration tests validate interactions between components:

- **tests/integration/server-coordinator.test.js**: Real UDP protocol flow between server and coordinator
- **tests/integration/client-coordinator.test.js**: Real HTTPS communication between client and coordinator

**Characteristics:**
- Use real protocol implementations
- Test component boundaries
- Validate handshakes and state transitions
- Medium execution time (5-15 seconds)

### End-to-End Tests

E2E tests validate complete user scenarios:

- **tests/e2e/full-system.test.js**: Complete coordinator + server startup and registration

**Characteristics:**
- Start real processes
- Test full workflows
- Validate system integration
- Longer execution time (10-30 seconds)

**Test Coverage:**
- Coordinator startup and key generation
- Server startup and registration
- Challenge-response authentication
- Keepalive maintenance

### System Tests

System tests validate system-level properties:

- **tests/system/multi-server.test.js**: Concurrent multi-server connections

**Characteristics:**
- Test scalability and concurrency
- Validate resource management
- Test edge cases and failure scenarios
- Variable execution time

**Test Coverage:**
- Multiple simultaneous server connections
- Concurrent registration handling
- Keepalive with multiple clients
- Graceful disconnection

## Test Principles

### 1. Real Implementations Over Mocks

Where practical, tests use real implementations rather than mocks:

- E2E tests start actual coordinator and server processes
- Integration tests use real UDP/HTTPS communication
- System tests use real concurrent connections

**Exception:** Unit tests mock external dependencies for isolation.

### 2. Proper Cleanup

All tests properly clean up resources:

```javascript
after(async () => {
  // Stop processes
  if (process) {
    process.kill('SIGTERM');
  }
  
  // Close sockets
  if (socket && !socket.destroyed) {
    socket.close();
  }
  
  // Remove temporary files
  await fs.rm(tmpDir, { recursive: true, force: true });
});
```

### 3. Timeout Handling

Tests include appropriate timeouts to prevent hanging:

```javascript
await Promise.race([
  operation(),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout')), 5000)
  )
]);
```

### 4. Isolation

Tests are independent and can run in any order:

- Each test uses unique ports or random ports
- Temporary files use unique names
- No shared state between tests

## Writing New Tests

### Unit Test Template

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('Component Name', () => {
  test('should do something', () => {
    const result = functionUnderTest();
    assert.strictEqual(result, expectedValue);
  });
});
```

### E2E Test Template

```javascript
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';

describe('E2E: Feature Name', () => {
  let process;
  
  before(async () => {
    // Start processes, create configs
  });
  
  after(async () => {
    // Cleanup processes, remove files
  });
  
  test('should complete workflow', async () => {
    // Test implementation
  });
});
```

## Test Results

### Current Coverage

| Component | Tests | Status |
|-----------|-------|--------|
| shared | 13 | ✅ 100% pass |
| coordinator | 30 | ✅ 100% pass |
| server | 53 | ✅ 100% pass |
| client | 30 | ✅ 100% pass |
| **E2E** | **3** | **✅ 100% pass** |
| **System** | **3** | **✅ 100% pass** |
| **Total** | **132** | **✅ 100% pass** |

### Test Execution Time

- Unit tests: ~2-3 seconds per component
- Integration tests: ~10-15 seconds
- E2E tests: ~15-20 seconds  
- System tests: ~5-10 seconds
- **Total**: ~2-3 minutes for full suite

## Continuous Integration

Tests are designed to run in CI environments:

- No interactive prompts
- Automatic cleanup even on failure
- Clear failure messages
- Exit codes indicate success/failure

## Troubleshooting

### Port Already in Use

If tests fail with `EADDRINUSE`, another process is using the port:

```bash
# Find process using port
lsof -i :3478

# Kill process
kill -9 <PID>
```

### Hanging Tests

If tests hang:

1. Check for missing cleanup in `after()` hooks
2. Verify all promises resolve/reject
3. Use timeouts for long-running operations
4. Check for unclosed sockets or processes

### WebRTC Library Dependencies

**Important:** System tests, integration tests, E2E tests, and server WebRTC tests require WebRTC libraries to be installed. These are **optional dependencies** and should be installed without modifying `package.json`.

#### Installing WebRTC Libraries

Install all supported libraries for your platform using `--no-save` flag:

```bash
# For server tests
cd server
npm install --no-save werift wrtc node-datachannel

# For E2E and system tests
cd tests
npm install --no-save werift wrtc node-datachannel
```

**Platform Notes:**
- **Linux/macOS:** All three libraries should install successfully
- **Windows:** `wrtc` and `node-datachannel` require build tools:
  ```bash
  npm install --global windows-build-tools
  ```
- **Alpine Linux:** Native modules may not work; use `werift` only
- **ARM (Raspberry Pi):** `werift` works reliably; others may require compilation

#### Installing Single Library

For minimal setup, install just `werift` (pure JavaScript, no compilation):

```bash
cd server
npm install --no-save werift

cd tests
npm install --no-save werift
```

#### Running WebRTC Tests

```bash
# Server WebRTC connectivity tests
cd server
npm run test:webrtc

# E2E and system tests (require WebRTC libraries)
cd tests
npm test
```

**Why `--no-save`?**
- Prevents modifying `package.json` or `package-lock.json`
- Keeps dependencies local to your environment
- Avoids committing platform-specific binaries
- Test libraries are listed as optional dependencies already

## Best Practices

1. **Keep tests fast**: Unit tests should run in milliseconds
2. **Test one thing**: Each test validates a single behavior
3. **Use descriptive names**: Test names should explain what is being tested
4. **Avoid test interdependence**: Tests should not rely on execution order
5. **Clean up resources**: Always close sockets, processes, and files
6. **Handle async properly**: Use async/await consistently
7. **Test error cases**: Don't just test the happy path
8. **Keep tests maintainable**: Avoid excessive mocking or complex setup

## Future Enhancements

Planned test improvements:

- [ ] File service E2E tests (upload/download over WebRTC)
- [ ] Authentication E2E tests
- [ ] Error scenario tests (network failures, timeouts)
- [ ] Performance benchmarks
- [ ] Load testing with 100+ concurrent servers
- [ ] Coordinator failover tests
- [ ] Long-running stability tests (24+ hours)
