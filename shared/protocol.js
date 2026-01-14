import dgram from 'dgram';
import {
  generateECDHKeyPair,
  computeECDHSecret,
  deriveAESKey,
  encryptAES,
  decryptAES,
  signData,
  verifySignature,
  signBinaryData,
  verifyBinarySignature,
  verifyHMAC,
  createHMAC,
  encodeECDHInit,
  decodeECDHInit,
  encodeECDHResponse,
  decodeECDHResponse,
  generateChallenge,
  hashChallengeAnswer
} from './crypto.js';

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

/**
 * UDP client for server-coordinator communication
 * Initiates connection and maintains encryption
 */
export class UDPClient {
  constructor(coordinatorHost, coordinatorPort, serverKeys, options = {}) {
    this.coordinatorHost = coordinatorHost;
    this.coordinatorPort = coordinatorPort;
    this.serverKeys = serverKeys;
    this.socket = null;
    
    this.challenge = null;
    this.expectedAnswer = null;
    this.aesKey = null;
    this.coordinatorPublicKey = options.coordinatorPublicKey || null;
    
    this.registered = false;
    this.handlers = new Map();
    this.keepaliveInterval = null;
    this.heartbeatInterval = null;
    this.state = 'disconnected'; // disconnected, registering, registered
    
    // Configurable intervals for testing
    this.keepaliveIntervalMs = options.keepaliveIntervalMs || 30000; // 30 seconds default
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 600000; // 10 minutes default
  }

  /**
   * Start UDP client and initiate registration
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        console.error('UDP client error:', err);
        this.state = 'disconnected';
        reject(err);
      });

      this.socket.on('message', (msg) => {
        this.handleMessage(msg);
      });

      this.socket.on('listening', () => {
        const address = this.socket.address();
        console.log(`Server listening on ${address.address}:${address.port}`);
        
        // Initiate ECDH registration
        this.initiateRegistration()
          .then(() => {
            console.log('Registration sequence initiated');
            resolve();
          })
          .catch((err) => {
            console.error('Failed to initiate registration:', err);
            reject(err);
          });
      });

      this.socket.bind(0); // Bind to any available port
    });
  }

  /**
   * Initiate ECDH registration (Phase 1)
   */
  async initiateRegistration() {
    try {
      this.state = 'registering';
      
      // Generate ECDH key pair
      const ecdhKeys = generateECDHKeyPair();
      this.ecdhKeys = ecdhKeys;
      
      // Encode ECDH init message
      const payload = encodeECDHInit(ecdhKeys.publicKey);
      
      // Send Phase 1: ECDH init
      const message = buildUDPMessage(MESSAGE_TYPES.ECDH_INIT, payload);
      
      this.socket.send(message, this.coordinatorPort, this.coordinatorHost, (err) => {
        if (err) {
          console.error('Error sending ECDH init:', err);
          throw err;
        }
        console.log('Sent ECDH init');
      });
    } catch (error) {
      this.state = 'disconnected';
      throw error;
    }
  }

  /**
   * Handle incoming message from coordinator
   */
  handleMessage(msg) {
    try {
      const { messageType, payload } = parseUDPMessage(msg);

      const typeName = MESSAGE_TYPE_NAMES[messageType] || 'unknown';
      console.log(`Received ${typeName} message`);

      switch (messageType) {
        case MESSAGE_TYPES.ECDH_RESPONSE:
          this.handleECDHResponse(payload);
          break;
        case MESSAGE_TYPES.REGISTER:
          this.handleRegisterAck(payload);
          break;
        case MESSAGE_TYPES.HEARTBEAT:
          this.handleHeartbeat(payload);
          break;
        default:
          console.warn(`Unexpected message type: 0x${messageType.toString(16)}`);
      }
    } catch (error) {
      console.error('Error handling message:', error.message);
    }
  }

  /**
   * Handle ECDH response (Phase 2)
   */
  async handleECDHResponse(payload) {
    try {
      if (!this.ecdhKeys) {
        console.error('No ECDH keys for response');
        return;
      }

      // Decode ECDH response
      const decoded = decodeECDHResponse(payload);

      // Compute shared secret
      const sharedSecret = computeECDHSecret(this.ecdhKeys.privateKey, decoded.ecdhPublicKey);

      // Decrypt signature data
      const key = deriveAESKey(sharedSecret.toString('hex'));
      const signatureData = decryptAES(decoded.encryptedData, key);

      // Verify coordinator's signature if we have the public key
      if (this.coordinatorPublicKey) {
        const dataToVerify = Buffer.concat([
          decoded.ecdhPublicKey,
          this.ecdhKeys.publicKey
        ]);
        
        const signature = Buffer.from(signatureData.signature, 'hex');
        if (!verifyBinarySignature(dataToVerify, signature, this.coordinatorPublicKey)) {
          throw new Error('Coordinator signature verification failed');
        }
        console.log('Coordinator signature verified');
      }

      // Store shared secret for phase 3
      this.sharedSecret = sharedSecret;
      this.coordinatorECDHPublicKey = decoded.ecdhPublicKey;

      // Proceed to Phase 3: Send registration
      await this.sendRegistration();
    } catch (error) {
      console.error('Error handling ECDH response:', error.message);
      this.state = 'disconnected';
    }
  }

  /**
   * Send registration (Phase 3)
   */
  async sendRegistration() {
    try {
      // Generate challenge and expectedAnswer
      const password = this.serverKeys.password || 'default'; // Should be configured
      this.challenge = this.challenge || generateChallenge();
      this.expectedAnswer = hashChallengeAnswer(this.challenge, password);
      this.aesKey = deriveAESKey(this.expectedAnswer);

      // Prepare registration data
      const registrationPayload = {
        challenge: this.challenge,
        challengeAnswerHash: this.expectedAnswer
      };

      // Sign ECDH keys binding
      const ecdhKeysData = Buffer.concat([
        this.ecdhKeys.publicKey,
        this.coordinatorECDHPublicKey
      ]);

      const timestamp = Date.now();

      const signatureData = {
        ecdhKeys: ecdhKeysData.toString('hex'),
        serverPublicKey: this.serverKeys.publicKey,
        timestamp,
        payload: registrationPayload
      };

      const signature = signData(signatureData, this.serverKeys.privateKey);

      // Encrypt registration with shared secret
      const fullPayload = {
        serverPublicKey: this.serverKeys.publicKey,
        timestamp,
        payload: registrationPayload,
        signature
      };

      const key = deriveAESKey(this.sharedSecret.toString('hex'));
      const encryptedPayload = encryptAES(fullPayload, key);

      // Send Phase 3: Registration
      const message = buildUDPMessage(MESSAGE_TYPES.REGISTER, encryptedPayload);

      this.socket.send(message, this.coordinatorPort, this.coordinatorHost, (err) => {
        if (err) {
          console.error('Error sending registration:', err);
          throw err;
        }
        console.log('Sent registration');
      });
    } catch (error) {
      console.error('Error sending registration:', error.message);
      this.state = 'disconnected';
    }
  }

  /**
   * Handle registration acknowledgment from coordinator
   */
  handleRegisterAck(payload) {
    try {
      // Decrypt with shared secret
      const key = deriveAESKey(this.sharedSecret.toString('hex'));
      const data = decryptAES(payload, key);

      if (data.status === 'ok' && data.type === 'register') {
        console.log('Registration acknowledged by coordinator');
        
        // Registration complete - start keepalive
        this.state = 'registered';
        this.registered = true;
        this.startKeepalive();
        
        // Emit registration complete event
        if (this.handlers.has('registered')) {
          this.handlers.get('registered')();
        }
      } else {
        console.error('Invalid registration acknowledgment');
        this.state = 'disconnected';
      }
    } catch (error) {
      console.error('Error handling registration ack:', error.message);
      this.state = 'disconnected';
    }
  }

  /**
   * Start keepalive ping
   */
  startKeepalive() {
    if (this.keepaliveInterval) clearInterval(this.keepaliveInterval);
    
    this.keepaliveInterval = setInterval(() => {
      if (this.registered && this.aesKey) {
        this.sendPing();
      }
    }, this.keepaliveIntervalMs);
    
    // Also start heartbeat interval
    this.startHeartbeat();
  }
  
  /**
   * Start heartbeat (challenge refresh)
   */
  startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    
    this.heartbeatInterval = setInterval(() => {
      if (this.registered && this.expectedAnswer) {
        this.sendHeartbeat();
      }
    }, this.heartbeatIntervalMs);
  }

  /**
   * Send ping message (optimized - no encryption, minimal overhead)
   */
  sendPing() {
    try {
      // Ping has no payload - just version and type bytes
      const message = buildUDPMessage(MESSAGE_TYPES.PING, Buffer.alloc(0));

      this.socket.send(message, this.coordinatorPort, this.coordinatorHost, (err) => {
        if (err) {
          console.error('Error sending ping:', err);
        }
      });
    } catch (error) {
      console.error('Error sending ping:', error.message);
    }
  }

  /**
   * Send heartbeat (challenge refresh)
   */
  sendHeartbeat() {
    try {
      // Generate new challenge
      const password = this.serverKeys.password || 'default';
      const newChallenge = generateChallenge();
      const newExpectedAnswer = hashChallengeAnswer(newChallenge, password);
      
      const hbPayload = {
        newChallenge,
        challengeAnswerHash: newExpectedAnswer
      };
      
      // Create HMAC using current expectedAnswer
      const hmac = createHMAC(hbPayload, this.expectedAnswer);
      
      const message = {
        type: 'heartbeat',
        payload: hbPayload,
        hmac
      };
      
      // Encrypt with current AES key (before updating)
      const encryptedPayload = encryptAES(message, this.aesKey);
      
      const udpMessage = buildUDPMessage(MESSAGE_TYPES.HEARTBEAT, encryptedPayload);

      this.socket.send(udpMessage, this.coordinatorPort, this.coordinatorHost, (err) => {
        if (err) {
          console.error('Error sending heartbeat:', err);
        } else {
          // Update local challenge and keys after sending
          this.challenge = newChallenge;
          this.expectedAnswer = newExpectedAnswer;
          this.aesKey = deriveAESKey(this.expectedAnswer);
          console.log('Heartbeat sent, challenge refreshed');
        }
      });
    } catch (error) {
      console.error('Error sending heartbeat:', error.message);
    }
  }

  /**
   * Handle heartbeat (challenge refresh)
   */
  handleHeartbeat(payload) {
    try {
      const data = decryptAES(payload, this.aesKey);

      if (data.type !== 'heartbeat') {
        console.warn('Invalid heartbeat message');
        return;
      }

      // Verify HMAC if present
      if (data.hmac && this.expectedAnswer) {
        const hmacData = {
          type: 'heartbeat',
          payload: data.payload
        };
        if (!verifyHMAC(hmacData, data.hmac, this.expectedAnswer)) {
          console.warn('Heartbeat HMAC verification failed');
          return;
        }
      }

      // Update challenge
      if (data.payload && data.payload.newChallenge) {
        this.challenge = data.payload.newChallenge;
        this.expectedAnswer = data.payload.challengeAnswerHash;
        this.aesKey = deriveAESKey(this.expectedAnswer);
        console.log('Challenge refreshed');
      }
    } catch (error) {
      console.error('Error handling heartbeat:', error.message);
    }
  }

  /**
   * Send SDP answer
   */
  async sendAnswer(sdpAnswer) {
    if (!this.registered || !this.aesKey) {
      throw new Error('Not registered');
    }

    try {
      const answerData = {
        type: 'answer',
        sdp: sdpAnswer
      };

      const payload = encryptAES(answerData, this.aesKey);

      const message = buildUDPMessage(MESSAGE_TYPES.ANSWER, payload);

      this.socket.send(message, this.coordinatorPort, this.coordinatorHost, (err) => {
        if (err) {
          console.error('Error sending answer:', err);
          throw err;
        }
      });
    } catch (error) {
      console.error('Error sending answer:', error.message);
      throw error;
    }
  }

  /**
   * Register event handler
   */
  on(event, handler) {
    this.handlers.set(event, handler);
  }

  /**
   * Stop UDP client
   */
  async stop() {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.socket) {
      await new Promise((resolve) => {
        this.socket.close(resolve);
      });
    }
    this.state = 'disconnected';
    this.registered = false;
  }
}

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
      
      const { messageType, payload } = parseUDPMessage(msg);

      // Route message based on type
      switch (messageType) {
        case MESSAGE_TYPES.ECDH_INIT:
          this.handleECDHInit(payload, ipPort, rinfo);
          break;
        case MESSAGE_TYPES.REGISTER:
          this.handleRegister(payload, ipPort, rinfo);
          break;
        case MESSAGE_TYPES.PING:
          this.handlePing(payload, ipPort, rinfo);
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
      
      // Generate coordinator's ECDH key pair
      const ecdhKeys = generateECDHKeyPair();
      
      // Compute shared secret immediately
      const sharedSecret = computeECDHSecret(ecdhKeys.privateKey, decoded.ecdhPublicKey);
      
      // Store ECDH session with shared secret
      this.ecdhSessions.set(ipPort, {
        ecdhKeys,
        serverECDHPublicKey: decoded.ecdhPublicKey,
        sharedSecret,
        timestamp: Date.now()
      });
      
      // Sign both ECDH public keys (coordinator's + server's) to bind them and prevent MITM
      const timestamp = Date.now();
      const dataToSign = Buffer.concat([
        ecdhKeys.publicKey,
        decoded.ecdhPublicKey
      ]);
      const signature = signBinaryData(dataToSign, this.coordinatorKeys.privateKey);
      
      // Encrypt signature data with shared secret
      const key = deriveAESKey(sharedSecret.toString('hex'));
      const signatureData = { 
        timestamp, 
        signature: signature.toString('hex')
      };
      const encryptedData = encryptAES(signatureData, key);
      
      // Encode and send ECDH response
      const responsePayload = encodeECDHResponse(ecdhKeys.publicKey, encryptedData);
      const message = buildUDPMessage(MESSAGE_TYPES.ECDH_RESPONSE, responsePayload);
      
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
      
      // Use stored shared secret
      const sharedSecret = session.sharedSecret;
      
      // Derive AES key from shared secret
      const key = deriveAESKey(sharedSecret.toString('hex'));
      
      // Decrypt registration message
      const message = decryptAES(payload, key);
      
      const { serverPublicKey, timestamp, payload: regPayload, signature } = message;

      if (!serverPublicKey || !regPayload || !signature) {
        console.error('Invalid registration message');
        return;
      }

      // Verify server's ECDSA signature on both ECDH public keys
      const ecdhKeysData = Buffer.concat([
        session.serverECDHPublicKey,
        session.ecdhKeys.publicKey
      ]);
      
      const dataToVerify = { 
        ecdhKeys: ecdhKeysData.toString('hex'),
        serverPublicKey, 
        timestamp, 
        payload: regPayload 
      };
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
        const response = buildUDPMessage(MESSAGE_TYPES.REGISTER, encryptedAck);
        
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
   * Handle keepalive ping (optimized - no decryption needed)
   */
  handlePing(payload, ipPort, rinfo) {
    // Ping is optimized - no payload to decrypt
    // Simply update timestamp for server
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
    const message = buildUDPMessage(messageType, payload);
    
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

