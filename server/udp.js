import dgram from 'dgram';
import { 
  generateECDHKeyPair, 
  computeECDHSecret, 
  verifyBinarySignature, 
  deriveAESKey, 
  decryptAES, 
  encryptAES, 
  signData, 
  verifySignature,
  encodeECDHInit, 
  decodeECDHResponse,
  generateChallenge,
  hashChallengeAnswer,
  signBinaryData,
  verifyHMAC
} from '../shared/crypto.js';
import { PROTOCOL_VERSION, MESSAGE_TYPES, MESSAGE_TYPE_NAMES, buildUDPMessage, parseUDPMessage } from '../shared/protocol.js';


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

      const signatureData = {
        ecdhKeys: ecdhKeysData.toString('hex'),
        serverPublicKey: this.serverKeys.publicKey,
        timestamp: Date.now(),
        payload: registrationPayload
      };

      const signature = signData(signatureData, this.serverKeys.privateKey);

      // Encrypt registration with shared secret
      const fullPayload = {
        serverPublicKey: this.serverKeys.publicKey,
        timestamp: Date.now(),
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
        
        // Registration complete - start keepalive
        this.state = 'registered';
        this.registered = true;
        this.startKeepalive();
        
        // Emit registration complete event
        if (this.handlers.has('registered')) {
          this.handlers.get('registered')();
        }
      });
    } catch (error) {
      console.error('Error sending registration:', error.message);
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
    }, 30000); // Every 30 seconds
  }

  /**
   * Send ping message
   */
  sendPing() {
    try {
      const payload = encryptAES({ type: 'ping' }, this.aesKey);
      
      const message = buildUDPMessage(MESSAGE_TYPES.PING, payload);

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
