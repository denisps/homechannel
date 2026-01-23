# WebRTC Libraries for Node.js

HomeChannel server supports three different WebRTC libraries for Node.js, each with different characteristics:

## Supported Libraries

### 1. werift (Default) ✅

**Pure JavaScript WebRTC implementation**

- **Installation:** `npm install werift`
- **Type:** Pure JavaScript (no native compilation required)
- **Pros:**
  - Easy to install on all platforms
  - No C++ compiler required
  - Actively maintained
  - Good documentation
- **Cons:**
  - Slightly slower than native implementations
  - Higher memory usage

**Configuration:**
```json
{
  "webrtc": {
    "library": "werift"
  }
}
```

### 2. wrtc (node-webrtc)

**Native bindings to Google's libwebrtc**

- **Installation:** `npm install wrtc`
- **Type:** Native module with C++ bindings
- **Pros:**
  - Best compatibility with browser WebRTC
  - Fast performance
  - Lower memory footprint
- **Cons:**
  - Requires C++ compiler (build-tools)
  - Installation can fail on some platforms
  - Maintenance has declined
  - Slow installation due to compilation

**Configuration:**
```json
{
  "webrtc": {
    "library": "wrtc"
  }
}
```

### 3. node-datachannel

**C++ bindings to libdatachannel**

- **Installation:** `npm install node-datachannel`
- **Type:** Native module with C++ bindings
- **Pros:**
  - Lightweight and fast
  - Focused on datachannel only
  - Good for minimal use cases
- **Cons:**
  - Requires C++ compiler
  - Less feature-complete
  - Different API from W3C standard

**Configuration:**
```json
{
  "webrtc": {
    "library": "node-datachannel"
  }
}
```

## Installation

Libraries are listed as **optional dependencies** in `package.json`. Install the one you need:

```bash
# Install werift (recommended)
npm install werift

# Or install wrtc
npm install wrtc

# Or install node-datachannel
npm install node-datachannel
```

## Abstraction Layer

HomeChannel provides a **W3C-compliant abstraction layer** that normalizes all three libraries to match the browser WebRTC API:

```javascript
import { createWebRTCPeer } from './webrtc.js';

// Create peer with specified library
const peer = await createWebRTCPeer('werift', {
  config: {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  }
});

if (!peer) {
  console.error('WebRTC library not available');
  return;
}

// Use standard W3C API
peer.on('datachannel', (channel) => {
  channel.onmessage = (event) => {
    console.log('Received:', event.data);
  };
});

await peer.handleOffer(offer);
const answer = await peer.createAnswer();
```

## Configuration

Set the library in [server/config.json](../server/config.json):

```json
{
  "coordinator": {
    "host": "127.0.0.1",
    "port": 3478,
    "publicKey": null
  },
  "password": "default-password",
  "webrtc": {
    "library": "werift"
  }
}
```

## Missing Library Warning

If the configured library is not installed, you'll see:

```
⚠️  WebRTC library 'werift' is not installed.
   Install it with: npm install werift
```

## Recommendations

**For development:**
- Use **werift** - easiest to install, no compilation required

**For production:**
- Use **werift** if you want simplicity and cross-platform support
- Use **wrtc** if you need maximum compatibility and performance
- Use **node-datachannel** if you only need datachannel and want minimal overhead

## API Differences Handled

The abstraction layer handles these differences automatically:

| Feature | werift | wrtc | node-datachannel |
|---------|--------|------|------------------|
| API Style | W3C | W3C | Custom |
| Event Handlers | `.on*` properties | `.on*` properties | `.on*()` methods |
| Send Method | `.send()` | `.send()` | `.sendMessage()` |
| Candidate Format | W3C RTCIceCandidate | W3C RTCIceCandidate | Custom format |

All differences are normalized by the [WebRTCPeer](../server/webrtc.js) class.
