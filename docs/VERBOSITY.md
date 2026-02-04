# Verbosity Configuration

## Overview
Both `UDPClient` (server-side) and `UDPServer` (coordinator-side) support verbosity levels to control logging output.

## Verbosity Levels

| Level | Name | Description |
|-------|------|-------------|
| 0 | Silent | Errors only |
| 1 | Normal | Important events (registration, migration, stop) - **Default** |
| 2 | Verbose | All messages with size and source IP:port |

## Usage

### Server (UDPClient)

```javascript
import { UDPClient } from './shared/protocol.js';

const client = new UDPClient(coordinatorHost, coordinatorPort, serverKeys, {
  verbosity: 2,  // Set verbosity level
  // ... other options
});

await client.start();
```

**Example output with `verbosity: 2`:**
```
Server listening on 0.0.0.0:51832
Registration sequence initiated
Sent HELLO
[UDP Client] Received 10 bytes from 127.0.0.1:13478
Received hello_ack message
HELLO_ACK verified, proceeding to ECDH
Sent ECDH init
[UDP Client] Received 280 bytes from 127.0.0.1:13478
Received ecdh_response message
Coordinator signature verified
Sent registration
[UDP Client] Received 63 bytes from 127.0.0.1:13478
Received register message
Registration acknowledged by coordinator
```

### Coordinator (UDPServer)

```javascript
import { UDPServer } from './shared/protocol.js';

const server = new UDPServer(registry, coordinatorKeys, {
  port: 3478,
  verbosity: 2,  // Set verbosity level
  // ... other options
});

await server.start();
```

**Example output with `verbosity: 2`:**
```
UDP server listening on 0.0.0.0:13478
[UDP Server] Received 6 bytes from 127.0.0.1:51832
[UDP Server] Received 72 bytes from 127.0.0.1:51832
[UDP Server] Received 505 bytes from 127.0.0.1:51832
Server registered: MFkwEwYHKoZIzj0CAQYI... at 127.0.0.1:51832
```

## Message Size and Source Logging

At verbosity level 2, all incoming UDP messages are logged with:
- **Message size** in bytes
- **Source IP:port** of the sender
- **Message type** (hello, hello_ack, ecdh_init, etc.)

This is useful for:
- Debugging connection issues
- Monitoring message flow
- Analyzing network traffic patterns
- Understanding protocol handshake sequence

## Configuration Files

### Server (config.json)
```json
{
  "coordinatorHost": "coordinator.example.com",
  "coordinatorPort": 3478,
  "verbosity": 1
}
```

### Coordinator
Pass verbosity as a command-line option or environment variable:
```bash
# Environment variable
COORDINATOR_VERBOSITY=2 node coordinator/index.js

# Or modify coordinator/index.js to accept a CLI flag
```

## Production Recommendations

- **Production**: Use `verbosity: 0` or `verbosity: 1` to minimize log noise
- **Staging**: Use `verbosity: 1` to see important events
- **Development/Debug**: Use `verbosity: 2` to see all message details

## Demo

See `shared/test/verbosity-demo.js` for a working example showing all verbosity levels in action.

```bash
cd shared
node test/verbosity-demo.js
```
