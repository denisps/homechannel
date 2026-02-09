# HomeChannel Client

Browser-compatible JavaScript client for establishing secure WebRTC datachannel connections to home servers via the HomeChannel coordinator.

## Features

- **Pure JavaScript**: ES modules, no build tools required
- **Browser-native**: Uses Web Crypto API and WebRTC
- **Secure**: Ed448 signature verification (configurable Ed25519), challenge-response authentication
- **Self-contained iframe**: Isolated coordinator communication
- **Event-driven**: Simple event API for connection lifecycle
- **Minimal dependencies**: No external libraries

## Usage

### Basic Example (HTML with Script Tags)

The client works from the local filesystem using a script tag:

```html
<!DOCTYPE html>
<html>
<head>
  <title>HomeChannel Client Example</title>
</head>
<body>
  <h1>HomeChannel Client</h1>
  <button id="connect">Connect</button>
  <div id="status"></div>
  <div id="messages"></div>
  
  <script src="apps/client.js"></script>
  <script>
    const { Client } = window.HomeChannelClient;
    
    const coordinatorUrl = 'https://coordinator.example.com';
    const serverPublicKey = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...
-----END PUBLIC KEY-----`;
    
    const client = new Client(coordinatorUrl);
    
    // Register event handlers
    client.on('connected', () => {
      console.log('Connected to server!');
      document.getElementById('status').textContent = 'Connected';
      
      // Send a message
      client.send({ type: 'hello', message: 'Hello from browser!' });
    });
    
    client.on('message', (data) => {
      console.log('Received:', data);
      const msg = document.createElement('div');
      msg.textContent = data;
      document.getElementById('messages').appendChild(msg);
    });
    
    client.on('disconnected', () => {
      console.log('Disconnected');
      document.getElementById('status').textContent = 'Disconnected';
    });
    
    client.on('error', (error) => {
      console.error('Error:', error);
      document.getElementById('status').textContent = `Error: ${error.message}`;
    });
    
    // Connect when button clicked
    document.getElementById('connect').addEventListener('click', async () => {
      try {
        const password = prompt('Enter password:');
        await client.connect(serverPublicKey, password);
      } catch (error) {
        console.error('Connection failed:', error);
      }
    });
  </script>
</body>
</html>
```

### ES Module Example (for Node.js tests)

The same file works as an ES module:

```javascript
import { Client } from './apps/client.js';

const client = new Client('https://coordinator.example.com');
// ... rest of the code
```

## API Reference

### `new Client(coordinatorUrl)`

Create a new client instance.

**Parameters:**
- `coordinatorUrl` (string): URL of the coordinator (e.g., `https://coordinator.example.com`)

### `client.connect(serverPublicKey, password)`

Establish connection to a server.

**Parameters:**
- `serverPublicKey` (string): Server's Ed25519/Ed448 public key in PEM format
- `password` (string): Password for challenge-response authentication

**Returns:** Promise that resolves when datachannel is established

**Throws:** Error if connection fails or server is offline

### `client.send(message)`

Send message over datachannel.

**Parameters:**
- `message` (string|object): Message to send (objects are JSON-serialized)

**Throws:** Error if not connected

### `client.disconnect()`

Close connection and cleanup resources.

### `client.on(event, handler)`

Register event handler.

**Events:**
- `connected`: Fired when datachannel is established
- `message`: Fired when message received (data passed to handler)
- `disconnected`: Fired when connection closes
- `error`: Fired on error (error object passed to handler)

## Connection Flow

1. **Create iframe**: Coordinator iframe loaded for signaling
2. **Get coordinator key**: Retrieve coordinator's Ed25519/Ed448 public key
3. **Get challenge**: Fetch server's current challenge
4. **Compute answer**: Hash challenge + password
5. **Create offer**: Generate WebRTC offer and gather ICE candidates
6. **Send offer**: Send offer + candidates + challenge answer to coordinator
7. **Poll for answer**: Wait for server's answer and ICE candidates
8. **Verify signature**: Validate server's Ed25519/Ed448 signature on answer
9. **Establish datachannel**: Set remote description and add ICE candidates
10. **Delete iframe**: Remove iframe after datachannel opens
11. **Ready**: Connection established, can send/receive messages

## Security

- All coordinator and server responses are signature-verified using Ed25519/Ed448 (per response metadata)
- Challenge-response prevents unauthorized access
- Iframe isolation sandboxes coordinator communication
- Only trusted server public keys should be used
- Passwords are never transmitted (only the hash)

## Files

- `apps/client.js` - Universal module (works as ES module or script tag)
- `apps/filebrowser.html` - Example file browser app
- `iframe.html` - Coordinator iframe (self-contained)
- `test/client.test.js` - Comprehensive test suite
- `test/filebrowser.test.js` - Filebrowser app tests

## Testing

```bash
npm test
```

## Browser Compatibility

- Modern browsers with WebRTC support
- Web Crypto API (all modern browsers)
- ES modules support

## License

GPL-3.0
