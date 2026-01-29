# System-Level Tests

This directory contains integration, end-to-end, and system tests that span multiple components of the HomeChannel system.

## Installation

Before running tests, install dependencies:

```bash
cd test
npm install
```

This will install required dependencies including Playwright for browser-based E2E tests. Tests will fail if dependencies are not installed.

## Test Categories

### Integration Tests (`integration/`)
Tests that verify interaction between multiple components:
- **webrtc-flow.test.js** - WebRTC connection establishment flow through coordinator
- **coordinator-server.test.js** - UDP communication and registration protocol

### End-to-End Tests (`e2e/`)
Tests that validate complete user workflows:
- **full-connection.test.js** - Complete client-server connection and data transfer
- **file-service.test.js** - File browsing and transfer operations

### System Tests (`system/`)
Tests that validate system-level behavior and resilience:
- **multiple-clients.test.js** - Concurrent client connections and scalability
- **failover.test.js** - Crash recovery and failover scenarios
- **load-test.test.js** - Performance under sustained load

## Running Tests

### All System Tests
```bash
# From project root
node --test test/**/*.test.js
```

### Specific Test Category
```bash
# Integration tests only
node --test test/integration/*.test.js

# End-to-end tests only
node --test test/e2e/*.test.js

# System tests only
node --test test/system/*.test.js
```

### Individual Test File
```bash
node --test test/integration/webrtc-flow.test.js
```

## Test Requirements

### Installation
```bash
cd test
npm install
```

### Dependencies
- **playwright** - Required for browser-based E2E tests (installed via npm)
- **Node.js built-ins** - All other tests use only built-in modules

Tests will fail if required dependencies are not installed. No mock implementations are used - all tests run against real component implementations.

### Prerequisites
- Coordinator and server components must be available in the workspace
- Proper network configuration for UDP and HTTPS communication
- Write permissions for temporary test files

## Test Environment

### Port Allocation
Tests use different ports to allow parallel execution:
- Integration tests: 13337-13340
- E2E tests: 13341-13342
- System tests: 13343-13345

### Isolation
Each test suite:
- Starts its own coordinator and server instances
- Uses temporary directories for file operations
- Cleans up resources after completion
- Can run in parallel with other test suites

## Adding New Tests

When adding system-level tests:

1. **Choose the right category:**
   - Integration: Testing component interactions
   - E2E: Testing complete user workflows
   - System: Testing resilience, scalability, performance

2. **Follow the pattern:**
   - Use Node.js built-in test runner
   - Async/await for all operations
   - Proper before/after cleanup
   - Meaningful test descriptions

3. **Port management:**
   - Use unique ports to avoid conflicts
   - Document port usage in this README

4. **Resource cleanup:**
   - Kill spawned processes in `after()` hooks
   - Remove temporary files and directories
   - Handle cleanup errors gracefully

## CI/CD Integration

These tests are designed to run in CI pipelines:
- No external service dependencies
- Configurable timeouts
- Clear pass/fail criteria
- Detailed error messages

### GitHub Actions Example
```yaml
- name: Run system tests
  run: node --test test/**/*.test.js
```

## Performance Expectations

### Response Times
- Health checks: < 50ms average
- Server list: < 100ms average
- WebRTC signaling: < 200ms setup

### Resource Usage
- Memory increase under load: < 50MB
- CPU usage: < 80% on single core
- Connection handling: 10+ concurrent clients

## Known Limitations

1. **Browser tests** require Playwright installation (optional)
2. **Load tests** may need adjustment based on hardware
3. **Network tests** assume localhost connectivity
4. **Timing tests** may be flaky on very slow machines

## Troubleshooting

### Port Conflicts
If tests fail with "address already in use":
```bash
# Find and kill process using port
lsof -ti:13337 | xargs kill -9
```

### Timeout Failures
Increase timeouts for slower machines by setting:
```bash
NODE_TEST_TIMEOUT=30000 node --test test/**/*.test.js
```

### Cleanup Issues
Manually cleanup test artifacts:
```bash
# Remove temp files
rm -rf /tmp/homechannel-test-*

# Kill lingering processes
pkill -f "node.*coordinator"
pkill -f "node.*server"
```
