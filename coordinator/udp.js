import dgram from 'dgram';
import { verifySignature, verifyHMAC, deriveAESKey, decryptAES, encryptAES, generateECDHKeyPair, computeECDHSecret, signBinaryData, verifyBinarySignature, decodeECDHInit, encodeECDHResponse } from './crypto.js';

/**
 * Binary protocol constants
 */
const PROTOCOL_VERSION = 0x01;
const MESSAGE_TYPES = {
  ECDH_INIT: 0x01,      // Phase 1: Server sends ECDH public key
  ECDH_RESPONSE: 0x02,  // Phase 2: Coordinator responds with ECDH public key
  REGISTER: 0x03,       // Phase 3: Server sends encrypted registration
  PING: 0x04,           // Keepalive
  HEARTBEAT: 0x05,      // Challenge refresh
  ANSWER: 0x06          // SDP answer
};

// Reverse mapping for logging
const MESSAGE_TYPE_NAMES = {
  0x01: 'ecdh_init',
  0x02: 'ecdh_response',
  0x03: 'register',
  0x04: 'ping',
  0x05: 'heartbeat',
  0x06: 'answer'
};

/**
 * UDP server for server-coordinator communication
 * Uses binary protocol: [version (1 byte)][type (1 byte)][payload]
 * ECDH-based two-phase registration
 */
export class UDPServer {
  constructor(registry, coordinatorKeys, options = {}) {
    this.registry = registry;
    this.coordinatorKeys = coordinatorKeys;
    this.port = options.port || 3478;
    this.socket = null;
    this.messageHandlers = new Map();
    
    // ECDH session state for pending registrations
    // Map: ipPort → { ecdhKeys, serverECDSAPublicKey, serverECDHPublicKey, timestamp }
    this.ecdhSessions = new Map();
    
    // Cleanup old ECDH sessions every 5 minutes
    this.ecdhCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [ipPort, session] of this.ecdhSessions.entries()) {
        if (now - session.timestamp > 300000) { // 5 minutes
          this.ecdhSessions.delete(ipPort);
        }
      }
    }, 300000);
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

      // Route message based on type
      switch (messageType) {
        case MESSAGE_TYPES.ECDH_INIT:
          this.handleECDHInit(payload, ipPort, rinfo);
          break;
        case MESSAGE_TYPES.REGISTER:
          this.handleRegister(payload, ipPort, rinfo);
          break;
        case MESSAGE_TYPES.PING:
          this.handlePing(ipPort, rinfo);
          break;
        case MESSAGE_TYPES.HEARTBEAT:
          this.handleHeartbeat(payload, ipPort, rinfo);
          break;
        case MESSAGE_TYPES.ANSWER:
          this.handleAnswer(payload, ipPort, rinfo);
          break;
        default:
          console.warn(`Unknown message type: 0x${messageType.toString(16)}`);
      }
    } catch (error) {
      console.error('Error handling UDP message:', error.message);
    }
  }

  /**
   * Handle ECDH init (Phase 1)
   */
  handleECDHInit(payload, ipPort, rinfo) {
    try {
      const decoded = decodeECDHInit(payload);
      
      // Verify ECDSA signature on ECDH public key
      if (!verifyBinarySignature(decoded.ecdhPublicKey, decoded.signature, decoded.ecdsaPublicKey)) {
        console.error('Invalid signature in ECDH init');
        return;
      }
      
      // Generate coordinator's ECDH key pair
      const ecdhKeys = generateECDHKeyPair();
      
      // Store ECDH session
      this.ecdhSessions.set(ipPort, {
        ecdhKeys,
        serverECDSAPublicKey: decoded.ecdsaPublicKey,
        serverECDHPublicKey: decoded.ecdhPublicKey,
        timestamp: Date.now()
      });
      
      // Sign coordinator's ECDH public key with coordinator's ECDSA key
      const timestamp = Date.now();
      const signature = signBinaryData(ecdhKeys.publicKey, this.coordinatorKeys.privateKey);
      
      // Encode and send ECDH response
      const responsePayload = encodeECDHResponse(ecdhKeys.publicKey, timestamp, signature);
      const message = Buffer.concat([
        Buffer.from([PROTOCOL_VERSION, MESSAGE_TYPES.ECDH_RESPONSE]),
        responsePayload
      ]);
      
      this.socket.send(message, rinfo.port, rinfo.address, (err) => {
        if (err) {
          console.error('Error sending ECDH response:', err);
        }
      });
      
      // Emit event for testing
      if (this.messageHandlers.has('ecdh_init')) {
        this.messageHandlers.get('ecdh_init')(decoded, ipPort);
      }
    } catch (error) {
      console.error('Error handling ECDH init:', error.message);
    }
  }

  /**
   * Handle server registration (Phase 3)
   */
  handleRegister(payload, ipPort, rinfo) {
    try {
      // Get ECDH session
      const session = this.ecdhSessions.get(ipPort);
      if (!session) {
        console.error('No ECDH session found for registration');
        return;
      }
      
      // Compute shared secret
      const sharedSecret = computeECDHSecret(session.ecdhKeys.privateKey, session.serverECDHPublicKey);
      
      // Derive AES key from shared secret
      const key = deriveAESKey(sharedSecret.toString('hex'));
      
      // Decrypt registration message
      const message = decryptAES(payload, key);
      
      const { serverPublicKey, timestamp, payload: regPayload, signature } = message;

      if (!serverPublicKey || !regPayload || !signature) {
        console.error('Invalid registration message');
        return;
      }

      // Verify ECDSA signature
      const dataToVerify = { serverPublicKey, timestamp, payload: regPayload };
      if (!verifySignature(dataToVerify, signature, serverPublicKey)) {
        console.error('Invalid signature in registration');
        return;
      }

      // Register server
      const { challenge, challengeAnswerHash } = regPayload;
      try {
        this.registry.register(serverPublicKey, ipPort, challenge, challengeAnswerHash);
        console.log(`Server registered: ${serverPublicKey.substring(0, 20)}... at ${ipPort}`);

        // Send acknowledgment (encrypted with shared secret)
        const ackMessage = { status: 'ok', type: 'register' };
        const encryptedAck = encryptAES(ackMessage, key);
        const response = Buffer.concat([
          Buffer.from([PROTOCOL_VERSION, MESSAGE_TYPES.REGISTER]),
          encryptedAck
        ]);
        
        this.socket.send(response, rinfo.port, rinfo.address, (err) => {
          if (err) {
            console.error('Error sending registration ack:', err);
          }
        });

        // Clean up ECDH session
        this.ecdhSessions.delete(ipPort);

        // Emit event for testing
        if (this.messageHandlers.has('register')) {
          this.messageHandlers.get('register')(message, ipPort);
        }
      } catch (error) {
        console.error('Error registering server:', error.message);
      }
    } catch (error) {
      console.error('Error handling registration:', error.message);
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
  handleHeartbeat(payload, ipPort, rinfo) {
    try {
      // Get expected answer (shared secret) for this server
      const expectedAnswer = this.registry.getExpectedAnswer(ipPort);
      if (!expectedAnswer) {
        console.error('Server not found for heartbeat');
        return;
      }

      // Decrypt using expectedAnswer as key
      const key = deriveAESKey(expectedAnswer);
      const message = decryptAES(payload, key);

      const { payload: hbPayload, hmac } = message;

      if (!hbPayload || !hmac) {
        console.error('Invalid heartbeat message');
        return;
      }

      // Verify HMAC using expectedAnswer as key
      if (!verifyHMAC(hbPayload, hmac, expectedAnswer)) {
        console.error('Invalid HMAC in heartbeat');
        return;
      }

      // Update challenge
      const { newChallenge, challengeAnswerHash } = hbPayload;
      this.registry.updateChallenge(ipPort, newChallenge, challengeAnswerHash);
      
      // Emit event for testing
      if (this.messageHandlers.has('heartbeat')) {
        this.messageHandlers.get('heartbeat')(message, ipPort);
      }
    } catch (error) {
      console.error('Error handling heartbeat:', error.message);
    }
  }

  /**
   * Handle SDP answer from server
   */
  handleAnswer(payload, ipPort, rinfo) {
    try {
      // Get expected answer (shared secret) for this server
      const expectedAnswer = this.registry.getExpectedAnswer(ipPort);
      if (!expectedAnswer) {
        console.error('Server not found for answer');
        return;
      }

      // Decrypt using expectedAnswer as key
      const key = deriveAESKey(expectedAnswer);
      const message = decryptAES(payload, key);

      const { serverPublicKey, sessionId, timestamp, payload: answerPayload, signature } = message;

      if (!serverPublicKey || !sessionId || !answerPayload || !signature) {
        console.error('Invalid answer message');
        return;
      }

      // Verify ECDSA signature
      const dataToVerify = { serverPublicKey, sessionId, timestamp, payload: answerPayload };
      if (!verifySignature(dataToVerify, signature, serverPublicKey)) {
        console.error('Invalid signature in answer');
        return;
      }

      // Emit event for testing/relay
      if (this.messageHandlers.has('answer')) {
        this.messageHandlers.get('answer')(message, sessionId);
      }
    } catch (error) {
      console.error('Error handling answer:', error.message);
    }
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
    if (expectedAnswer && messageType !== MESSAGE_TYPES.ECDH_INIT && messageType !== MESSAGE_TYPES.ECDH_RESPONSE) {
      // Encrypt message using expectedAnswer as key
      const key = deriveAESKey(expectedAnswer);
      payload = encryptAES(data, key);
    } else {
      // Unencrypted (for ECDH messages)
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
    // Clear ECDH cleanup interval
    if (this.ecdhCleanupInterval) {
      clearInterval(this.ecdhCleanupInterval);
    }
    
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
