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
  encodeHello,
  decodeHello,
  encodeHelloAck,
  decodeHelloAck,
  encodeECDHInit,
  decodeECDHInit,
  encodeECDHResponse,
  decodeECDHResponse,
  generateChallenge,
  hashChallengeAnswer,
  unwrapPublicKey,
  wrapPublicKey
} from './crypto.js';

// Shared protocol constants for HomeChannel UDP messaging
export const PROTOCOL_VERSION = 0x01;

export const MESSAGE_TYPES = Object.freeze({
  HELLO: 0x01,          // Phase 1: Server sends random tag (DoS prevention)
  HELLO_ACK: 0x02,      // Phase 2: Coordinator responds with tag (rate-limited)
  ECDH_INIT: 0x03,      // Phase 3: Server sends ECDH public key + coordinator tag
  ECDH_RESPONSE: 0x04,  // Phase 4: Coordinator responds with ECDH public key
  REGISTER: 0x05,       // Phase 5: Server sends encrypted registration
  PING: 0x06,           // Keepalive
  HEARTBEAT: 0x07,      // Challenge refresh
  ANSWER: 0x08,         // SDP answer
  MIGRATE: 0x09,        // Coordinator migration (redirect to new coordinator)
  OFFER: 0x0A,          // SDP offer (coordinator to server)
  ERROR: 0xFF           // Error response (not sent for HELLO messages)
});

export const MESSAGE_TYPE_NAMES = Object.freeze({
  [MESSAGE_TYPES.HELLO]: 'hello',
  [MESSAGE_TYPES.HELLO_ACK]: 'hello_ack',
  [MESSAGE_TYPES.ECDH_INIT]: 'ecdh_init',
  [MESSAGE_TYPES.ECDH_RESPONSE]: 'ecdh_response',
  [MESSAGE_TYPES.REGISTER]: 'register',
  [MESSAGE_TYPES.PING]: 'ping',
  [MESSAGE_TYPES.HEARTBEAT]: 'heartbeat',
  [MESSAGE_TYPES.ANSWER]: 'answer',
  [MESSAGE_TYPES.MIGRATE]: 'migrate',
  [MESSAGE_TYPES.OFFER]: 'offer',
  [MESSAGE_TYPES.ERROR]: 'error'
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
   * Initiate registration with HELLO exchange (Phase 1)
   */
  async initiateRegistration() {
    try {
      this.state = 'registering';
      
      // Generate random 4-byte tag
      const crypto = await import('crypto');
      this.serverTag = crypto.default.randomBytes(4);
      
      // Encode HELLO message
      const payload = encodeHello(this.serverTag);
      
      // Send Phase 1: HELLO
      const message = buildUDPMessage(MESSAGE_TYPES.HELLO, payload);
      
      this.socket.send(message, this.coordinatorPort, this.coordinatorHost, (err) => {
        if (err) {
          console.error('Error sending HELLO:', err);
          throw err;
        }
        console.log('Sent HELLO');
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
        case MESSAGE_TYPES.HELLO_ACK:
          this.handleHelloAck(payload);
          break;
        case MESSAGE_TYPES.ECDH_RESPONSE:
          this.handleECDHResponse(payload);
          break;
        case MESSAGE_TYPES.REGISTER:
          this.handleRegisterAck(payload);
          break;
        case MESSAGE_TYPES.HEARTBEAT:
          this.handleHeartbeat(payload);
          break;
        case MESSAGE_TYPES.MIGRATE:
          this.handleMigrate(payload);
          break;
        case MESSAGE_TYPES.ERROR:
          this.handleError(payload);
          break;
        default:
          console.warn(`Unexpected message type: 0x${messageType.toString(16)}`);
      }
    } catch (error) {
      console.error('Error handling message:', error.message);
    }
  }

  /**
   * Handle HELLO_ACK (Phase 2)
   */
  async handleHelloAck(payload) {
    try {
      const decoded = decodeHelloAck(payload);
      
      // Verify server tag matches what we sent
      if (!this.serverTag || !this.serverTag.equals(decoded.serverTag)) {
        console.error('Server tag mismatch in HELLO_ACK');
        this.state = 'disconnected';
        return;
      }
      
      // Store coordinator's tag for Phase 3
      this.coordinatorTag = decoded.coordinatorTag;
      
      console.log('HELLO_ACK verified, proceeding to ECDH');
      
      // Now proceed to Phase 3: ECDH Init
      await this.sendECDHInit();
    } catch (error) {
      console.error('Error handling HELLO_ACK:', error.message);
      this.state = 'disconnected';
    }
  }

  /**
   * Send ECDH Init (Phase 3)
   */
  async sendECDHInit() {
    try {
      // Generate ECDH key pair
      const ecdhKeys = generateECDHKeyPair();
      this.ecdhKeys = ecdhKeys;
      
      // Encode ECDH init message with coordinator's tag
      const payload = encodeECDHInit(this.coordinatorTag, ecdhKeys.publicKey);
      
      // Send Phase 3: ECDH init
      const message = buildUDPMessage(MESSAGE_TYPES.ECDH_INIT, payload);
      
      this.socket.send(message, this.coordinatorPort, this.coordinatorHost, (err) => {
        if (err) {
          console.error('Error sending ECDH init:', err);
          throw err;
        }
        console.log('Sent ECDH init');
      });
    } catch (error) {
      console.error('Error sending ECDH init:', error.message);
      this.state = 'disconnected';
    }
  }

  /**
   * Handle ECDH response (Phase 4)
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
   * Send registration (Phase 5)
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

      // Use unwrapped (base64) key consistently in signature and payload
      const unwrappedPublicKey = unwrapPublicKey(this.serverKeys.publicKey);

      const signatureData = {
        ecdhKeys: ecdhKeysData.toString('hex'),
        serverPublicKey: unwrappedPublicKey,
        timestamp,
        payload: registrationPayload
      };

      const signature = signData(signatureData, this.serverKeys.privateKey);

      // Encrypt registration with shared secret
      // Send unwrapped public key (base64 only) for efficiency
      const fullPayload = {
        serverPublicKey: unwrappedPublicKey,
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
      
      const message = {
        type: 'heartbeat',
        payload: hbPayload
      };
      
      // Encrypt with current AES key (before updating)
      // AES-GCM provides both encryption and authentication
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
      // AES-GCM decryption automatically verifies authentication
      // If decryption succeeds, message is authentic
      const data = decryptAES(payload, this.aesKey);

      if (data.type !== 'heartbeat') {
        console.warn('Invalid heartbeat message');
        return;
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
   * Handle MIGRATE message from coordinator
   * Coordinator requests server to migrate to a different coordinator
   */
  handleMigrate(payload) {
    try {
      if (!this.aesKey) {
        console.error('Cannot process MIGRATE - no AES key established');
        return;
      }

      // AES-GCM decryption automatically verifies authentication
      const data = decryptAES(payload, this.aesKey);

      if (data.type !== 'migrate') {
        console.warn('Invalid migrate message type');
        return;
      }

      const { host, port, publicKey } = data.payload;

      if (!host || !port || !publicKey) {
        console.error('Invalid migrate payload - missing required fields');
        return;
      }

      console.log(`Coordinator migration requested to ${host}:${port}`);

      // Emit migration event for server to handle
      if (this.handlers.has('migrate')) {
        this.handlers.get('migrate')({ host, port, publicKey });
      } else {
        console.warn('No migrate handler registered - migration ignored');
      }
    } catch (error) {
      console.error('Error handling migrate message:', error.message);
    }
  }

  /**
   * Handle ERROR message from coordinator
   */
  handleError(payload) {
    // ERROR has no payload (rate limiting/ban notification)
    console.error('Received ERROR from coordinator - likely rate limited or banned');
    this.state = 'disconnected';
    this.registered = false;
    
    // Stop keepalive and heartbeat
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
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
      const sessionId = sdpAnswer.sessionId || 'unknown';
      const timestamp = Date.now();
      const payload = { 
        sdp: sdpAnswer.sdp || sdpAnswer,
        candidates: sdpAnswer.candidates || []
      };

      // Use unwrapped (base64) key consistently in signature and payload
      const unwrappedPublicKey = unwrapPublicKey(this.serverKeys.publicKey);

      // Sign the answer
      const dataToSign = {
        serverPublicKey: unwrappedPublicKey,
        sessionId,
        timestamp,
        payload
      };
      const signature = signData(dataToSign, this.serverKeys.privateKey);

      // Send unwrapped public key (base64 only) for efficiency
      const answerData = {
        type: 'answer',
        serverPublicKey: unwrappedPublicKey,
        sessionId,
        timestamp,
        payload,
        signature
      };

      const encryptedPayload = encryptAES(answerData, this.aesKey);

      const message = buildUDPMessage(MESSAGE_TYPES.ANSWER, encryptedPayload);

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
      this.keepaliveInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.socket) {
      // Remove all event listeners to prevent memory leaks
      this.socket.removeAllListeners();
      // Unref socket so it doesn't keep event loop alive
      this.socket.unref();
      await new Promise((resolve) => {
        this.socket.close(resolve);
      });
      this.socket = null;
    }
    this.state = 'disconnected';
    this.registered = false;
    console.log('UDP client stopped');
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
    this.port = options.port !== undefined ? options.port : 3478;
    this.socket = null;
    this.messageHandlers = new Map();
    
    // HELLO session state for DoS prevention
    // Map: ipPort → { coordinatorTag, timestamp }
    // Note: ipPort cannot be trusted at this stage, only used for reply routing
    this.helloSessions = new Map();
    
    // ECDH session state for pending registrations
    // Map: ipPort → { ecdhKeys, serverECDSAPublicKey, serverECDHPublicKey, timestamp }
    this.ecdhSessions = new Map();
    
    // Rate limiting: track HELLO_ACK replies sent (not incoming HELLOs)
    // Source IP cannot be trusted at HELLO stage, only limit our replies
    this.helloAttempts = new Map(); // ipPort → [timestamps of replies sent]
    this.maxHelloPerMinute = options.maxHelloPerMinute || 10;
    
    // Cleanup old sessions every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      
      // Cleanup HELLO sessions (timeout: 30 seconds)
      for (const [ipPort, session] of this.helloSessions.entries()) {
        if (now - session.timestamp > 30000) {
          this.helloSessions.delete(ipPort);
        }
      }
      
      // Cleanup ECDH sessions (timeout: 5 minutes)
      for (const [ipPort, session] of this.ecdhSessions.entries()) {
        if (now - session.timestamp > 300000) {
          this.ecdhSessions.delete(ipPort);
        }
      }
      
      // Cleanup old rate limit data (keep last 1 minute)
      // Note: This tracks REPLIES sent, not incoming HELLOs
      for (const [ipPort, timestamps] of this.helloAttempts.entries()) {
        const recent = timestamps.filter(t => now - t < 60000);
        if (recent.length === 0) {
          this.helloAttempts.delete(ipPort);
        } else {
          this.helloAttempts.set(ipPort, recent);
        }
      }
    }, 60000).unref(); // Every minute, unref so it doesn't keep event loop alive
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
        case MESSAGE_TYPES.HELLO:
          this.handleHello(payload, ipPort, rinfo);
          break;
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
   * Handle HELLO (Phase 1) - DoS prevention
   * 
   * IMPORTANT: Source IP:port cannot be trusted at this stage.
   * Rate-limiting is based on REPLIES sent, not incoming HELLOs.
   * No ERROR responses are sent to avoid amplification attacks.
   */
  async handleHello(payload, ipPort, rinfo) {
    try {
      const now = Date.now();
      
      // Check rate limit on REPLIES (not incoming HELLOs)
      const attempts = this.helloAttempts.get(ipPort) || [];
      const recentAttempts = attempts.filter(t => now - t < 60000);
      
      if (recentAttempts.length >= this.maxHelloPerMinute) {
        console.warn(`Rate limit exceeded for replies to ${ipPort} - silently dropping`);
        // Silently drop - do not send ERROR (prevents amplification)
        return;
      }
      
      // Decode HELLO
      const decoded = decodeHello(payload);
      
      // Generate coordinator's random tag
      const crypto = await import('crypto');
      const coordinatorTag = crypto.default.randomBytes(4);
      
      // Store session (only coordinator's tag, not server's)
      // Server will echo its own tag back, no need to store it
      this.helloSessions.set(ipPort, {
        coordinatorTag,
        timestamp: now
      });
      
      // Send HELLO_ACK (Phase 2)
      const responsePayload = encodeHelloAck(decoded.serverTag, coordinatorTag);
      const message = buildUDPMessage(MESSAGE_TYPES.HELLO_ACK, responsePayload);
      
      this.socket.send(message, rinfo.port, rinfo.address, (err) => {
        if (err) {
          console.error('Error sending HELLO_ACK:', err);
        } else {
          // Log reply attempt for rate limiting
          recentAttempts.push(now);
          this.helloAttempts.set(ipPort, recentAttempts);
        }
      });
      
      // Emit event for testing
      if (this.messageHandlers.has('hello')) {
        this.messageHandlers.get('hello')(decoded, ipPort);
      }
    } catch (error) {
      console.error('Error handling HELLO:', error.message);
    }
  }

  /**
   * Handle ECDH init (Phase 3) - Now requires valid coordinator tag
   */
  handleECDHInit(payload, ipPort, rinfo) {
    try {
      const decoded = decodeECDHInit(payload);
      
      // Verify coordinator tag before expensive ECDH operation
      const helloSession = this.helloSessions.get(ipPort);
      if (!helloSession) {
        console.error('No HELLO session for ECDH init');
        return;
      }
      
      if (!helloSession.coordinatorTag.equals(decoded.coordinatorTag)) {
        console.error('Invalid coordinator tag in ECDH init');
        this.helloSessions.delete(ipPort);
        return;
      }
      
      // Tag verified - proceed with ECDH (expensive operation)
      // Clean up HELLO session
      this.helloSessions.delete(ipPort);
      
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
   * Handle server registration (Phase 5)
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
      
      const { serverPublicKey: base64PublicKey, timestamp, payload: regPayload, signature } = message;

      if (!base64PublicKey || !regPayload || !signature) {
        console.error('Invalid registration message');
        return;
      }

      // Wrap received base64 key to PEM for verification
      const serverPublicKey = wrapPublicKey(base64PublicKey);

      // Verify server's ECDSA signature on both ECDH public keys
      const ecdhKeysData = Buffer.concat([
        session.serverECDHPublicKey,
        session.ecdhKeys.publicKey
      ]);
      
      // Verify with base64 key (what was actually signed)
      const dataToVerify = { 
        ecdhKeys: ecdhKeysData.toString('hex'),
        serverPublicKey: base64PublicKey, 
        timestamp, 
        payload: regPayload 
      };
      // But verify signature using PEM format (what crypto.verify expects)
      if (!verifySignature(dataToVerify, signature, serverPublicKey)) {
        console.error('Invalid signature in registration');
        return;
      }

      // Register server
      const { challenge, challengeAnswerHash } = regPayload;
      try {
        // Store unwrapped (base64) key in registry for efficiency
        this.registry.register(base64PublicKey, ipPort, challenge, challengeAnswerHash);
        console.log(`Server registered: ${base64PublicKey.substring(0, 20)}... at ${ipPort}`);

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
      // AES-GCM decryption automatically verifies authentication
      const key = deriveAESKey(expectedAnswer);
      const message = decryptAES(payload, key);

      const { payload: hbPayload } = message;

      if (!hbPayload) {
        console.error('Invalid heartbeat message');
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

      const { serverPublicKey: base64PublicKey, sessionId, timestamp, payload: answerPayload, signature } = message;

      if (!base64PublicKey || !sessionId || !answerPayload || !signature) {
        console.error('Invalid answer message');
        return;
      }

      // Wrap received base64 key to PEM for verification
      const serverPublicKey = wrapPublicKey(base64PublicKey);

      // Verify ECDSA signature (verify with base64 key, what was actually signed)
      const dataToVerify = { serverPublicKey: base64PublicKey, sessionId, timestamp, payload: answerPayload };
      // But verify signature using PEM format (what crypto.verify expects)
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
   * Send offer to server
   * Called by HTTPS server when client initiates connection
   */
  async sendOfferToServer(ipPort, sessionId, payload) {
    const [address, port] = ipPort.split(':');
    
    // Get expectedAnswer for encryption
    const expectedAnswer = this.registry.getExpectedAnswer(ipPort);
    if (!expectedAnswer) {
      throw new Error('Server not found');
    }
    
    // Build offer message
    const offerData = {
      type: 'offer',
      sessionId,
      timestamp: Date.now(),
      payload
    };
    
    // Encrypt message using expectedAnswer as key
    const key = deriveAESKey(expectedAnswer);
    const encryptedPayload = encryptAES(offerData, key);
    
    // Build binary message: [version][type][payload]
    const message = buildUDPMessage(MESSAGE_TYPES.OFFER, encryptedPayload);
    
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
   * Stop UDP server
   */
  stop() {
    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    return new Promise((resolve) => {
      if (this.socket) {
        // Remove all event listeners to prevent memory leaks
        this.socket.removeAllListeners();
        // Unref socket so it doesn't keep event loop alive
        this.socket.unref();
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

