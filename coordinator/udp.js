import dgram from 'dgram';
import { PROTOCOL_VERSION, MESSAGE_TYPES, MESSAGE_TYPE_NAMES, buildUDPMessage, parseUDPMessage } from '../shared/protocol.js';
import { verifySignature, verifyHMAC, deriveAESKey, decryptAES, encryptAES, generateECDHKeyPair, computeECDHSecret, signBinaryData, verifyBinarySignature, decodeECDHInit, encodeECDHResponse } from '../shared/crypto.js';


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
      
      // No signature verification here - server identity not revealed yet
      // Just extract ECDH public key
      
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
      // Use session-stored keys to reconstruct what server should have signed
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
