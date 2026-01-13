import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import dgram from 'dgram';
import { ServerRegistry } from '../registry.js';
import { UDPServer } from '../../shared/protocol.js';
import { PROTOCOL_VERSION, MESSAGE_TYPES } from '../../shared/protocol.js';
import { 
  generateECDSAKeyPair, 
  signData, 
  verifySignature, 
  createHMAC, 
  generateChallenge, 
  hashChallengeAnswer, 
  deriveAESKey, 
  encryptAES, 
  decryptAES,
  generateECDHKeyPair,
  computeECDHSecret,
  signBinaryData,
  verifyBinarySignature,
  encodeECDHInit,
  decodeECDHResponse
} from '../../shared/crypto.js';

/**
 * Mock server for testing (uses ECDH-based binary protocol)
 */
class MockServer {
  constructor(coordinatorPublicKey = null) {
    this.socket = dgram.createSocket('udp4');
    this.keys = generateECDSAKeyPair();
    this.serverPublicKey = this.keys.publicKey;
    this.serverPrivateKey = this.keys.privateKey;
    this.coordinatorPublicKey = coordinatorPublicKey;
    this.coordinatorPort = 0;
    this.responses = [];
    this.sharedSecret = null;
  }

  async start() {
    return new Promise((resolve) => {
      this.socket.on('message', (msg) => {
        // Store binary response for later parsing
        this.responses.push(msg);
      });

      this.socket.bind(() => {
        resolve(this.socket.address().port);
      });
    });
  }

  async sendRegister(coordinatorPort, challenge, expectedAnswer) {
    // Phase 1: Send ECDH init (only ECDH public key, no signature)
    const ecdhKeys = generateECDHKeyPair();
    this.ecdhKeys = ecdhKeys;
    
    const ecdhInitPayload = encodeECDHInit(ecdhKeys.publicKey);
    
    await this.sendBinary(ecdhInitPayload, coordinatorPort, MESSAGE_TYPES.ECDH_INIT);
    
    // Wait for ECDH response
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const ecdhResponse = this.getLastResponse();
    if (!ecdhResponse || ecdhResponse.length < 2) {
      throw new Error('No ECDH response received');
    }
    
    // Parse ECDH response
    const version = ecdhResponse[0];
    const messageType = ecdhResponse[1];
    const payload = ecdhResponse.slice(2);
    
    if (version !== PROTOCOL_VERSION || messageType !== MESSAGE_TYPES.ECDH_RESPONSE) {
      throw new Error('Invalid ECDH response');
    }
    
    const decoded = decodeECDHResponse(payload);
    
    // Compute shared secret
    this.sharedSecret = computeECDHSecret(ecdhKeys.privateKey, decoded.ecdhPublicKey);
    
    // Decrypt signature data to verify coordinator identity
    const key = deriveAESKey(this.sharedSecret.toString('hex'));
    const signatureData = decryptAES(decoded.encryptedData, key);
    
    // Verify coordinator's signature on both ECDH keys if we have coordinator's public key
    if (this.coordinatorPublicKey) {
      // Reconstruct what coordinator signed: coordinator's ECDH key + server's ECDH key
      const dataToVerify = Buffer.concat([
        decoded.ecdhPublicKey,  // Coordinator's ECDH public key
        ecdhKeys.publicKey      // Server's ECDH public key (our own)
      ]);
      const signature = Buffer.from(signatureData.signature, 'hex');
      
      if (!verifyBinarySignature(dataToVerify, signature, this.coordinatorPublicKey)) {
        throw new Error('Invalid coordinator signature on ECDH keys');
      }
    } else {
      // Just check that decryption worked and we got valid data
      if (!signatureData.timestamp || !signatureData.signature) {
        throw new Error('Invalid signature data in ECDH response');
      }
    }
    
    // Clear responses
    this.responses = [];
    
    // Phase 3: Send encrypted registration
    const regTimestamp = Date.now();
    const regPayload = {
      challenge,
      challengeAnswerHash: expectedAnswer
    };
    
    // Server signs both ECDH keys to bind them (no need to send keys back)
    const ecdhKeysData = Buffer.concat([
      ecdhKeys.publicKey,       // Server's ECDH public key
      decoded.ecdhPublicKey     // Coordinator's ECDH public key
    ]);
    
    const regMessage = {
      serverPublicKey: this.serverPublicKey,
      timestamp: regTimestamp,
      payload: regPayload,
      signature: signData({ 
        ecdhKeys: ecdhKeysData.toString('hex'),
        serverPublicKey: this.serverPublicKey, 
        timestamp: regTimestamp, 
        payload: regPayload 
      }, this.serverPrivateKey)
    };
    
    // Encrypt with shared secret
    const encryptedPayload = encryptAES(regMessage, key);
    
    await this.sendBinary(encryptedPayload, coordinatorPort, MESSAGE_TYPES.REGISTER);
  }

  sendPing(coordinatorPort, expectedAnswer) {
    const message = { type: 'ping' };
    return this.send(message, coordinatorPort, MESSAGE_TYPES.PING, true, expectedAnswer);
  }

  sendHeartbeat(coordinatorPort, expectedAnswer, newChallenge, newExpectedAnswer) {
    const payload = {
      newChallenge,
      challengeAnswerHash: newExpectedAnswer
    };

    const message = {
      type: 'heartbeat',
      payload,
      hmac: createHMAC(payload, expectedAnswer)
    };

    return this.send(message, coordinatorPort, MESSAGE_TYPES.HEARTBEAT, true, expectedAnswer);
  }

  sendAnswer(coordinatorPort, expectedAnswer, sessionId, sdp, candidates) {
    const payload = { sdp, candidates };

    const message = {
      type: 'answer',
      serverPublicKey: this.serverPublicKey,
      sessionId,
      timestamp: Date.now(),
      payload,
      signature: signData({ 
        serverPublicKey: this.serverPublicKey, 
        sessionId, 
        timestamp: Date.now(), 
        payload 
      }, this.serverPrivateKey)
    };

    return this.send(message, coordinatorPort, MESSAGE_TYPES.ANSWER, true, expectedAnswer);
  }

  send(message, coordinatorPort, messageType, encrypt = false, expectedAnswer = null) {
    return new Promise((resolve, reject) => {
      let payload;
      
      if (encrypt && expectedAnswer) {
        // Encrypt message using expectedAnswer as key
        const key = deriveAESKey(expectedAnswer);
        payload = encryptAES(message, key);
      } else {
        // Unencrypted JSON
        payload = Buffer.from(JSON.stringify(message), 'utf8');
      }
      
      // Build binary message: [version][type][payload]
      const binaryMessage = Buffer.concat([
        Buffer.from([PROTOCOL_VERSION, messageType]),
        payload
      ]);
      
      this.socket.send(binaryMessage, coordinatorPort, 'localhost', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  sendBinary(payload, coordinatorPort, messageType) {
    return new Promise((resolve, reject) => {
      // Build binary message: [version][type][payload]
      const binaryMessage = Buffer.concat([
        Buffer.from([PROTOCOL_VERSION, messageType]),
        payload
      ]);
      
      this.socket.send(binaryMessage, coordinatorPort, 'localhost', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  getLastResponse() {
    return this.responses[this.responses.length - 1];
  }

  clearResponses() {
    this.responses = [];
  }

  stop() {
    return new Promise((resolve) => {
      this.socket.close(() => resolve());
    });
  }
}

/**
 * Tests
 */
describe('ServerRegistry', () => {
  let registry;

  before(() => {
    registry = new ServerRegistry({ serverTimeout: 5000 });
  });

  after(() => {
    registry.destroy();
  });

  test('should register a server', () => {
    const publicKey = 'test-key-1';
    const ipPort = '127.0.0.1:12345';
    const challenge = 'challenge1';
    const expectedAnswer = 'answer1';

    registry.register(publicKey, ipPort, challenge, expectedAnswer);

    const server = registry.getServerByPublicKey(publicKey);
    assert.strictEqual(server.ipPort, ipPort);
    assert.strictEqual(server.challenge, challenge);
    assert.strictEqual(server.expectedAnswer, expectedAnswer);
  });

  test('should get server by IP:port', () => {
    const publicKey = 'test-key-2';
    const ipPort = '127.0.0.1:12346';

    registry.register(publicKey, ipPort, 'challenge', 'answer');

    const server = registry.getServerByIpPort(ipPort);
    assert.strictEqual(server.publicKey, publicKey);
  });

  test('should update timestamp', async () => {
    const publicKey = 'test-key-3';
    const ipPort = '127.0.0.1:12347';

    registry.register(publicKey, ipPort, 'challenge', 'answer');

    const before = registry.getServerByPublicKey(publicKey).timestamp;
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 10));
    
    registry.updateTimestamp(ipPort);
    const after = registry.getServerByPublicKey(publicKey).timestamp;
    assert.ok(after > before);
  });

  test('should update challenge', () => {
    const publicKey = 'test-key-4';
    const ipPort = '127.0.0.1:12348';

    registry.register(publicKey, ipPort, 'challenge1', 'answer1');
    registry.updateChallenge(ipPort, 'challenge2', 'answer2');

    const server = registry.getServerByPublicKey(publicKey);
    assert.strictEqual(server.challenge, 'challenge2');
    assert.strictEqual(server.expectedAnswer, 'answer2');
  });

  test('should verify challenge', () => {
    const publicKey = 'test-key-5';
    const ipPort = '127.0.0.1:12349';
    const expectedAnswer = 'correct-answer';

    registry.register(publicKey, ipPort, 'challenge', expectedAnswer);

    assert.strictEqual(registry.verifyChallenge(publicKey, expectedAnswer), true);
    assert.strictEqual(registry.verifyChallenge(publicKey, 'wrong-answer'), false);
  });

  test('should track connection attempts for rate limiting', () => {
    const clientId = 'client-1';

    assert.strictEqual(registry.isRateLimited(clientId, 3), false);

    registry.logConnectionAttempt(clientId);
    registry.logConnectionAttempt(clientId);
    registry.logConnectionAttempt(clientId);

    assert.strictEqual(registry.isRateLimited(clientId, 3), true);
  });
});

describe('Coordinator with Mock Server', () => {
  let registry;
  let udpServer;
  let mockServer;
  let coordinatorKeys;
  let coordinatorPort;

  before(async () => {
    // Generate coordinator keys
    coordinatorKeys = generateECDSAKeyPair();

    // Create registry and UDP server
    registry = new ServerRegistry({ serverTimeout: 60000 });
    udpServer = new UDPServer(registry, coordinatorKeys, { port: 0 });

    // Start UDP server
    await udpServer.start();
    coordinatorPort = udpServer.socket.address().port;

    // Create and start mock server with coordinator's public key
    mockServer = new MockServer(coordinatorKeys.publicKey);
    await mockServer.start();
  });

  after(async () => {
    await mockServer.stop();
    await udpServer.stop();
    registry.destroy();
  });

  test('should handle server registration', async () => {
    const challenge = generateChallenge();
    const expectedAnswer = hashChallengeAnswer(challenge, 'password123');

    let registered = false;
    udpServer.on('register', () => {
      registered = true;
    });

    await mockServer.sendRegister(coordinatorPort, challenge, expectedAnswer);

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.strictEqual(registered, true);

    const server = registry.getServerByPublicKey(mockServer.serverPublicKey);
    assert.ok(server);
    assert.strictEqual(server.challenge, challenge);
    assert.strictEqual(server.expectedAnswer, expectedAnswer);
  });

  test('should handle keepalive ping', async () => {
    // First register
    const challenge = generateChallenge();
    const expectedAnswer = hashChallengeAnswer(challenge, 'password123');
    await mockServer.sendRegister(coordinatorPort, challenge, expectedAnswer);
    await new Promise(resolve => setTimeout(resolve, 100));

    const ipPort = registry.getServerByPublicKey(mockServer.serverPublicKey).ipPort;
    const timestampBefore = registry.getServerByPublicKey(mockServer.serverPublicKey).timestamp;

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 50));

    // Send encrypted ping
    await mockServer.sendPing(coordinatorPort, expectedAnswer);
    await new Promise(resolve => setTimeout(resolve, 100));

    const timestampAfter = registry.getServerByPublicKey(mockServer.serverPublicKey).timestamp;
    assert.ok(timestampAfter > timestampBefore, 'Timestamp should be updated after ping');
  });

  test('should handle challenge refresh heartbeat', async () => {
    // First register
    const challenge1 = generateChallenge();
    const expectedAnswer1 = hashChallengeAnswer(challenge1, 'password123');
    await mockServer.sendRegister(coordinatorPort, challenge1, expectedAnswer1);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Send heartbeat with new challenge
    const challenge2 = generateChallenge();
    const expectedAnswer2 = hashChallengeAnswer(challenge2, 'password123');

    let heartbeatReceived = false;
    udpServer.on('heartbeat', () => {
      heartbeatReceived = true;
    });

    await mockServer.sendHeartbeat(coordinatorPort, expectedAnswer1, challenge2, expectedAnswer2);
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.strictEqual(heartbeatReceived, true);

    const server = registry.getServerByPublicKey(mockServer.serverPublicKey);
    assert.strictEqual(server.challenge, challenge2);
    assert.strictEqual(server.expectedAnswer, expectedAnswer2);
  });

  test('should handle SDP answer', async () => {
    // First register
    const challenge = generateChallenge();
    const expectedAnswer = hashChallengeAnswer(challenge, 'password123');
    await mockServer.sendRegister(coordinatorPort, challenge, expectedAnswer);
    await new Promise(resolve => setTimeout(resolve, 100));

    const sessionId = 'session-123';
    const sdp = { type: 'answer', sdp: 'v=0...' };
    const candidates = [{ candidate: 'candidate:1...' }];

    let answerReceived = false;
    let receivedSessionId = null;

    udpServer.on('answer', (message, sid) => {
      answerReceived = true;
      receivedSessionId = sid;
    });

    await mockServer.sendAnswer(coordinatorPort, expectedAnswer, sessionId, sdp, candidates);
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.strictEqual(answerReceived, true);
    assert.strictEqual(receivedSessionId, sessionId);
  });

  test('should reject invalid signature in registration', async () => {
    // Create a fresh mock server with new keys for this test
    const testMockServer = new MockServer(coordinatorKeys.publicKey);
    await testMockServer.start();

    // Phase 1: Send ECDH init (only ECDH public key, no signature)
    const ecdhKeys = generateECDHKeyPair();
    
    const ecdhInitPayload = encodeECDHInit(ecdhKeys.publicKey);
    
    await testMockServer.sendBinary(ecdhInitPayload, coordinatorPort, MESSAGE_TYPES.ECDH_INIT);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Get ECDH response and compute shared secret
    const ecdhResponse = testMockServer.getLastResponse();
    const decoded = decodeECDHResponse(ecdhResponse.slice(2));
    const sharedSecret = computeECDHSecret(ecdhKeys.privateKey, decoded.ecdhPublicKey);
    
    testMockServer.clearResponses();

    const challenge = generateChallenge();
    const expectedAnswer = hashChallengeAnswer(challenge, 'password123');

    // Create message with wrong signature
    const regPayload = {
      challenge,
      challengeAnswerHash: expectedAnswer
    };

    // Create message with wrong signature (don't need to send ECDH keys)
    const message = {
      serverPublicKey: testMockServer.serverPublicKey,
      timestamp: Date.now(),
      payload: regPayload,
      signature: 'invalid-signature'
    };

    // Encrypt with shared secret
    const key = deriveAESKey(sharedSecret.toString('hex'));
    const encryptedPayload = encryptAES(message, key);

    await testMockServer.sendBinary(encryptedPayload, coordinatorPort, MESSAGE_TYPES.REGISTER);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Server should not be registered
    const server = registry.getServerByPublicKey(testMockServer.serverPublicKey);
    assert.strictEqual(server, undefined);

    await testMockServer.stop();
  });

  test('should reject invalid HMAC in heartbeat', async () => {
    // First register
    const challenge1 = generateChallenge();
    const expectedAnswer1 = hashChallengeAnswer(challenge1, 'password123');
    await mockServer.sendRegister(coordinatorPort, challenge1, expectedAnswer1);
    await new Promise(resolve => setTimeout(resolve, 100));

    const challenge2 = generateChallenge();
    const expectedAnswer2 = hashChallengeAnswer(challenge2, 'password123');

    const payload = {
      newChallenge: challenge2,
      challengeAnswerHash: expectedAnswer2
    };

    // Send with wrong HMAC
    const message = {
      type: 'heartbeat',
      payload,
      hmac: 'invalid-hmac'
    };

    await mockServer.send(message, coordinatorPort, MESSAGE_TYPES.HEARTBEAT, true, expectedAnswer1);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Challenge should not be updated
    const server = registry.getServerByPublicKey(mockServer.serverPublicKey);
    assert.strictEqual(server.challenge, challenge1);
  });
});

console.log('All tests defined. Run with: npm test');
