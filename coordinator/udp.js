import dgram from 'dgram';
import { verifySignature, verifyHMAC, deriveAESKey, decryptAES, encryptAES, decodeBinaryRegistration, encodeBinaryRegistration } from './crypto.js';

/**
 * Binary protocol constants
 */
const PROTOCOL_VERSION = 0x01;
const MESSAGE_TYPES = {
  REGISTER: 0x01,
  PING: 0x02,
  HEARTBEAT: 0x03,
  ANSWER: 0x04
};

// Reverse mapping for logging
const MESSAGE_TYPE_NAMES = {
  0x01: 'register',
  0x02: 'ping',
  0x03: 'heartbeat',
  0x04: 'answer'
};

/**
 * UDP server for server-coordinator communication
 * Uses binary protocol: [version (1 byte)][type (1 byte)][payload]
 */
export class UDPServer {
  constructor(registry, coordinatorKeys, options = {}) {
    this.registry = registry;
    this.coordinatorKeys = coordinatorKeys;
    this.port = options.port || 3478;
    this.socket = null;
    this.messageHandlers = new Map();
  }

  /**
   * Start UDP server
   */
  start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        console.error('UDP server error:', err);
        reject(err);
      });

      this.socket.on('message', (msg, rinfo) => {
        this.handleMessage(msg, rinfo);
      });

      this.socket.on('listening', () => {
        const address = this.socket.address();
        console.log(`UDP server listening on ${address.address}:${address.port}`);
        resolve();
      });

      this.socket.bind(this.port);
    });
  }

  /**
   * Handle incoming UDP message (binary protocol)
   * Format: [version (1 byte)][type (1 byte)][payload]
   * Registration is unencrypted JSON, all others are AES-CTR encrypted
   */
  handleMessage(msg, rinfo) {
    try {
      const ipPort = `${rinfo.address}:${rinfo.port}`;
      
      // Minimum message size: version + type
      if (msg.length < 2) {
        console.error('Message too short');
        return;
      }

      const version = msg[0];
      const messageType = msg[1];
      const payload = msg.slice(2);

      // Check protocol version
      if (version !== PROTOCOL_VERSION) {
        console.error(`Unsupported protocol version: ${version}`);
        return;
      }

      let message;

      // Handle registration (binary format)
      if (messageType === MESSAGE_TYPES.REGISTER) {
        try {
          const decoded = decodeBinaryRegistration(payload);
          message = {
            type: 'register',
            serverPublicKey: decoded.serverPublicKey,
            timestamp: decoded.timestamp,
            payload: {
              challenge: decoded.challenge,
              challengeAnswerHash: decoded.challengeAnswerHash
            },
            signature: decoded.signature
          };
        } catch (error) {
          console.error('Failed to parse binary registration message:', error.message);
          return;
        }
      } else {
        // All other messages are AES-CTR encrypted
        const expectedAnswer = this.registry.getExpectedAnswer(ipPort);
        if (!expectedAnswer) {
          console.error('Cannot decrypt message: server not registered');
          return;
        }
        
        // Decrypt using expectedAnswer as key
        const key = deriveAESKey(expectedAnswer);
        message = decryptAES(payload, key);
      }

      // Route message based on type
      const typeName = MESSAGE_TYPE_NAMES[messageType] || message.type;
      
      switch (messageType) {
        case MESSAGE_TYPES.REGISTER:
          this.handleRegister(message, ipPort, rinfo);
          break;
        case MESSAGE_TYPES.PING:
          this.handlePing(ipPort, rinfo);
          break;
        case MESSAGE_TYPES.HEARTBEAT:
          this.handleHeartbeat(message, ipPort, rinfo);
          break;
        case MESSAGE_TYPES.ANSWER:
          this.handleAnswer(message, ipPort, rinfo);
          break;
        default:
          console.warn(`Unknown message type: 0x${messageType.toString(16)}`);
      }
    } catch (error) {
      console.error('Error handling UDP message:', error.message);
    }
  }

  /**
   * Handle server registration
   */
  handleRegister(message, ipPort, rinfo) {
    const { serverPublicKey, timestamp, payload, signature } = message;

    if (!serverPublicKey || !payload || !signature) {
      console.error('Invalid registration message');
      return;
    }

    // Verify ECDSA signature
    const dataToVerify = { serverPublicKey, timestamp, payload };
    if (!verifySignature(dataToVerify, signature, serverPublicKey)) {
      console.error('Invalid signature in registration');
      return;
    }

    // Register server
    const { challenge, challengeAnswerHash } = payload;
    try {
      this.registry.register(serverPublicKey, ipPort, challenge, challengeAnswerHash);
      console.log(`Server registered: ${serverPublicKey.substring(0, 20)}... at ${ipPort}`);

      // Send acknowledgment
      this.sendResponse(rinfo, { status: 'ok', type: 'register' });

      // Emit event for testing
      if (this.messageHandlers.has('register')) {
        this.messageHandlers.get('register')(message, ipPort);
      }
    } catch (error) {
      console.error('Error registering server:', error.message);
      this.sendResponse(rinfo, { status: 'error', message: error.message });
    }
  }

  /**
   * Handle keepalive ping
   */
  handlePing(ipPort, rinfo) {
    // Update timestamp for server
    const updated = this.registry.updateTimestamp(ipPort);
    
    if (updated) {
      // No response needed for ping (minimal overhead)
      if (this.messageHandlers.has('ping')) {
        this.messageHandlers.get('ping')(ipPort);
      }
    }
  }

  /**
   * Handle challenge refresh heartbeat
   */
  handleHeartbeat(message, ipPort, rinfo) {
    const { payload, hmac } = message;

    if (!payload || !hmac) {
      console.error('Invalid heartbeat message');
      return;
    }

    // Get expected answer (shared secret) for this server
    const expectedAnswer = this.registry.getExpectedAnswer(ipPort);
    if (!expectedAnswer) {
      console.error('Server not found for heartbeat');
      return;
    }

    // Verify HMAC using expectedAnswer as key
    if (!verifyHMAC(payload, hmac, expectedAnswer)) {
      console.error('Invalid HMAC in heartbeat');
      return;
    }

    // Update challenge
    const { newChallenge, challengeAnswerHash } = payload;
    this.registry.updateChallenge(ipPort, newChallenge, challengeAnswerHash);
    
    // Emit event for testing
    if (this.messageHandlers.has('heartbeat')) {
      this.messageHandlers.get('heartbeat')(message, ipPort);
    }
  }

  /**
   * Handle SDP answer from server
   */
  handleAnswer(message, ipPort, rinfo) {
    const { serverPublicKey, sessionId, timestamp, payload, signature } = message;

    if (!serverPublicKey || !sessionId || !payload || !signature) {
      console.error('Invalid answer message');
      return;
    }

    // Verify ECDSA signature
    const dataToVerify = { serverPublicKey, sessionId, timestamp, payload };
    if (!verifySignature(dataToVerify, signature, serverPublicKey)) {
      console.error('Invalid signature in answer');
      return;
    }

    // Emit event for testing/relay
    if (this.messageHandlers.has('answer')) {
      this.messageHandlers.get('answer')(message, sessionId);
    }
  }

  /**
   * Send response to client
   */
  sendResponse(rinfo, data) {
    const message = Buffer.from(JSON.stringify(data));
    this.socket.send(message, rinfo.port, rinfo.address, (err) => {
      if (err) {
        console.error('Error sending UDP response:', err);
      }
    });
  }

  /**
   * Send message to server using binary protocol
   * Format: [version (1 byte)][type (1 byte)][payload]
   */
  sendToServer(ipPort, data, messageType) {
    const [address, port] = ipPort.split(':');
    
    // Get expectedAnswer for encryption
    const expectedAnswer = this.registry.getExpectedAnswer(ipPort);
    
    let payload;
    if (expectedAnswer && messageType !== MESSAGE_TYPES.REGISTER) {
      // Encrypt message using expectedAnswer as key
      const key = deriveAESKey(expectedAnswer);
      payload = encryptAES(data, key);
    } else {
      // Unencrypted JSON (for registration responses)
      payload = Buffer.from(JSON.stringify(data), 'utf8');
    }
    
    // Build binary message: [version][type][payload]
    const message = Buffer.concat([
      Buffer.from([PROTOCOL_VERSION, messageType]),
      payload
    ]);
    
    return new Promise((resolve, reject) => {
      this.socket.send(message, parseInt(port), address, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Register message handler (for testing and relay)
   */
  on(type, handler) {
    this.messageHandlers.set(type, handler);
  }

  /**
   * Stop UDP server
   */
  stop() {
    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.close(() => {
          console.log('UDP server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
