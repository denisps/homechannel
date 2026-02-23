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
  "crypto": {
    "signatureAlgorithm": "ed448",
    "keyAgreementCurve": "x448"
  },
  "port": 0,
  "webrtc": {
    "library": "werift"
  },
  "apps": ["files"],
  "appsConfig": {
    "files": {
      "enabled": true,
      "rootDir": "/home/user",
      "allowedDirs": ["/home/user", "/home/user/documents"],
      "maxFileSize": 104857600
    }
  }
}
```

If you change `crypto.signatureAlgorithm`, regenerate server keys to match the new algorithm.

See [../docs/WEBRTC_LIBRARIES.md](../docs/WEBRTC_LIBRARIES.md) for library options.

## Running

```bash
npm start
```

The server will:
1. Generate or load Ed448 keypair from `keys/` (configurable Ed25519)
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

## Apps

The server provides apps through WebRTC datachannels. Each app runs on its own channel and is delivered as an ES module bundle.

### File App

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

Configure apps in `config.json`:

```json
{
  "apps": ["files"],
  "appsConfig": {
    "files": {
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
├── apps/                 # App implementations
│   └── files/            # File app module
├── services/             # Legacy services (to be migrated)
├── test/                 # Test suite
│   ├── server.test.js    # Server UDP tests
│   ├── migration.test.js # Coordinator migration tests
│   ├── file.test.js      # File service tests
│   ├── router.test.js    # Service router tests
│   ├── webrtc.test.js    # WebRTC abstraction tests
│   └── webrtc-connectivity.test.js  # Optional WebRTC tests
└── keys/                 # Ed25519/Ed448 keypair (generated on first run)
```

### Adding Apps

1. Create app module in `apps/your-app/`
2. Export an async entry point (e.g. `async run(context)`)
3. Add app name to `apps` in `config.json`
4. Add app settings under `appsConfig.your-app`
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
