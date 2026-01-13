// Shared protocol constants for HomeChannel UDP messaging
export const PROTOCOL_VERSION = 0x01;

export const MESSAGE_TYPES = Object.freeze({
  ECDH_INIT: 0x01,      // Phase 1: Server sends ECDH public key
  ECDH_RESPONSE: 0x02,  // Phase 2: Coordinator responds with ECDH public key
  REGISTER: 0x03,       // Phase 3: Server sends encrypted registration
  PING: 0x04,           // Keepalive
  HEARTBEAT: 0x05,      // Challenge refresh
  ANSWER: 0x06          // SDP answer
});

export const MESSAGE_TYPE_NAMES = Object.freeze({
  [MESSAGE_TYPES.ECDH_INIT]: 'ecdh_init',
  [MESSAGE_TYPES.ECDH_RESPONSE]: 'ecdh_response',
  [MESSAGE_TYPES.REGISTER]: 'register',
  [MESSAGE_TYPES.PING]: 'ping',
  [MESSAGE_TYPES.HEARTBEAT]: 'heartbeat',
  [MESSAGE_TYPES.ANSWER]: 'answer'
});

// Build binary UDP message: [version (1 byte)][type (1 byte)][payload]
export function buildUDPMessage(messageType, payloadBuffer) {
  return Buffer.concat([
    Buffer.from([PROTOCOL_VERSION, messageType]),
    payloadBuffer
  ]);
}

// Parse binary UDP message and validate protocol version
export function parseUDPMessage(msg) {
  if (msg.length < 2) {
    throw new Error('Message too short');
  }

  const version = msg[0];
  const messageType = msg[1];
  const payload = msg.slice(2);

  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  return { messageType, payload };
}
