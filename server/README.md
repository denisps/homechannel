# HomeChannel Server

Node.js server that runs on your home network and provides WebRTC datachannel access to local services.

## Installation

```bash
cd server
npm install

# Install a WebRTC library (choose one)
npm install werift  # Recommended: pure JavaScript
# npm install wrtc  # Alternative: native bindings
# npm install node-datachannel  # Alternative: lightweight
```

## Configuration

Edit `config.json`:

```json
{
  "coordinator": {
    "host": "your-coordinator.example.com",
    "port": 3478,
    "publicKey": null
  },
  "password": "your-secure-password",
  "privateKeyPath": "keys/server.key",
  "publicKeyPath": "keys/server.pub",
  "port": 0,
  "webrtc": {
    "library": "werift"
  }
}
```

See [../docs/WEBRTC_LIBRARIES.md](../docs/WEBRTC_LIBRARIES.md) for library options.

## Running

```bash
npm start
```

The server will:
1. Generate or load ECDSA keypair from `keys/`
2. Connect to coordinator via UDP
3. Complete registration handshake
4. Wait for WebRTC connection requests from clients

## Testing

### Standard Tests

Run the standard test suite (no WebRTC library required):

```bash
npm test
```

This runs 49 tests including:
- UDP protocol and registration
- File service operations
- Service router functionality
- WebRTC abstraction layer (mocked)

### WebRTC Connectivity Tests (Optional)

Test actual WebRTC connectivity and performance with installed libraries:

```bash
npm run test:webrtc
```

This requires at least one WebRTC library to be installed. It tests:

**Connectivity Tests:**
- Peer connection creation
- ICE server configuration
- Offer/answer exchange
- Event handler registration
- ICE candidate tracking
- Clean shutdown

**Performance Tests:**
- Peer creation speed
- Multiple peer handling
- Offer/answer creation time
- Rapid open/close cycles

**Compatibility Tests:**
- Consistent API across libraries
- Event handler compatibility

Example output:
```
Checking WebRTC library availability...
  ✅ werift available
  ⚠️  wrtc not installed (skipping tests)
  ⚠️  node-datachannel not installed (skipping tests)

Running tests for: werift

✔ werift library (6 tests)
✔ werift performance (4 tests)
✔ Abstraction Compatibility (1 test)

✅ All connectivity tests passed!
```

If no libraries are installed, the tests will gracefully skip with instructions.

### Run All Tests

```bash
npm run test:all
```

Runs both standard tests and WebRTC connectivity tests.

## Services

The server provides these services through WebRTC datachannel:

### File Service

Access files on your home network:
- `listDirectory` - List files and folders
- `readFile` - Read file contents (text or binary)
- `writeFile` - Write file contents
- `deleteFile` - Delete files
- `createDirectory` - Create directories
- `deleteDirectory` - Delete directories
- `getFileInfo` - Get file metadata

See [FILE_SERVICE.md](FILE_SERVICE.md) for detailed API documentation.

### Configuration

Configure services in `config.json`:

```json
{
  "services": {
    "file": {
      "enabled": true,
      "allowedDirectories": ["/home/user/Documents", "/var/www"],
      "maxFileSize": 10485760
    }
  }
}
```

## Development

### File Structure

```
server/
├── index.js              # Main server entry point
├── webrtc.js             # WebRTC abstraction layer
├── config.json           # Server configuration
├── package.json          # Dependencies and scripts
├── services/             # Service implementations
│   ├── index.js          # Service router
│   └── file.js           # File service
├── test/                 # Test suite
│   ├── server.test.js    # Server UDP tests
│   ├── migration.test.js # Coordinator migration tests
│   ├── file.test.js      # File service tests
│   ├── router.test.js    # Service router tests
│   ├── webrtc.test.js    # WebRTC abstraction tests
│   └── webrtc-connectivity.test.js  # Optional WebRTC tests
└── keys/                 # ECDSA keypair (generated on first run)
```

### Adding Services

1. Create service implementation in `services/your-service.js`
2. Export service class with `handleMessage(message)` method
3. Register in `services/index.js`
4. Add service configuration to `config.json`
5. Add tests

## Troubleshooting

### WebRTC Library Not Found

If you see:
```
⚠️  WebRTC library 'werift' is not installed.
   Install it with: npm install werift
```

Install the configured library:
```bash
npm install werift
# or npm install wrtc
# or npm install node-datachannel
```

### Registration Fails

- Check coordinator is running and accessible
- Verify `coordinator.host` and `coordinator.port` in config
- Ensure firewall allows UDP traffic on coordinator port
- Check password matches between server and coordinator

### Connection Fails

- Verify server is registered (check logs)
- Ensure NAT/firewall allows STUN/TURN traffic
- Check client has correct server public key
- Verify WebRTC library is installed and working

## License

GPL-3.0 - See [../LICENSE](../LICENSE) for details.
