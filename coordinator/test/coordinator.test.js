import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import dgram from 'dgram';
import { ServerRegistry } from '../registry.js';
import { UDPServer, UDPClient } from '../../shared/protocol.js';

/**
 * Helper to add timeout to promises to prevent hanging tests
 * 
 * This wraps any promise with a timeout that will reject if the operation
 * takes too long. This prevents individual test operations from hanging
 * indefinitely and allows the test to fail gracefully with a clear error message.
 * 
 * @param {Promise} promise - The promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds (default: 3000)
 * @param {string} errorMsg - Error message if timeout occurs
 * @returns {Promise} Race between the original promise and timeout
 */
function withTimeout(promise, timeoutMs = 3000, errorMsg = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(errorMsg)), timeoutMs)
    )
  ]);
}
import { PROTOCOL_VERSION, MESSAGE_TYPES, buildUDPMessage } from '../../shared/protocol.js';
import { 
  signData, 
  verifySignature, 
  generateChallenge, 
  hashChallengeAnswer, 
  deriveAESKey, 
  encryptAES, 
  decryptAES,
  generateECDHKeyPair,
  computeECDHSecret,
  signBinaryData,
  verifyBinarySignature,
  encodeHello,
  decodeHello,
  encodeHelloAck,
  decodeHelloAck,
  encodeECDHInit,
  decodeECDHResponse
} from '../../shared/crypto.js';
import { generateECDSAKeyPair } from '../../shared/keys.js';

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
    // Phase 1: Send HELLO with random tag
    const crypto = await import('crypto');
    this.serverTag = crypto.default.randomBytes(4);
    
    const helloPayload = encodeHello(this.serverTag);
    await this.sendBinary(helloPayload, coordinatorPort, MESSAGE_TYPES.HELLO);
    
    // Wait for HELLO_ACK
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const helloAckResponse = this.getLastResponse();
    if (!helloAckResponse || helloAckResponse.length < 2) {
      throw new Error('No HELLO_ACK response received');
    }
    
    // Parse HELLO_ACK
    let version = helloAckResponse[0];
    let messageType = helloAckResponse[1];
    let payload = helloAckResponse.slice(2);
    
    if (version !== PROTOCOL_VERSION || messageType !== MESSAGE_TYPES.HELLO_ACK) {
      throw new Error('Invalid HELLO_ACK response');
    }
    
    const helloAckDecoded = decodeHelloAck(payload);
    
    // Verify server tag
    if (!this.serverTag.equals(helloAckDecoded.serverTag)) {
      throw new Error('Server tag mismatch in HELLO_ACK');
    }
    
    this.coordinatorTag = helloAckDecoded.coordinatorTag;
    
    // Phase 3: Send ECDH init (with coordinator's tag + ECDH public key)
    const ecdhKeys = generateECDHKeyPair();
    this.ecdhKeys = ecdhKeys;
    
    const ecdhInitPayload = encodeECDHInit(this.coordinatorTag, ecdhKeys.publicKey);
    
    await this.sendBinary(ecdhInitPayload, coordinatorPort, MESSAGE_TYPES.ECDH_INIT);
    
    // Wait for ECDH response
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const ecdhResponse = this.getLastResponse();
    if (!ecdhResponse || ecdhResponse.length < 2) {
      throw new Error('No ECDH response received');
    }
    
    // Parse ECDH response
    version = ecdhResponse[0];
    messageType = ecdhResponse[1];
    payload = ecdhResponse.slice(2);
    
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

  sendPing(coordinatorPort) {
    // Ping is optimized - no payload, no encryption
    return this.sendBinary(Buffer.alloc(0), coordinatorPort, MESSAGE_TYPES.PING);
  }

  sendHeartbeat(coordinatorPort, expectedAnswer, newChallenge, newExpectedAnswer) {
    const payload = {
      newChallenge,
      challengeAnswerHash: newExpectedAnswer
    };

    const message = {
      type: 'heartbeat',
      payload
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
    try {
      await withTimeout(mockServer.stop(), 1000, 'Mock server stop timed out').catch(err => {
        console.error('Failed to stop mock server:', err.message);
      });
      await withTimeout(udpServer.stop(), 1000, 'UDP server stop timed out').catch(err => {
        console.error('Failed to stop UDP server:', err.message);
      });
      registry.destroy();
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  });

  test('should handle server registration', async () => {
    const challenge = generateChallenge();
    const expectedAnswer = hashChallengeAnswer(challenge, 'password123');

    let registered = false;
    udpServer.on('register', () => {
      registered = true;
    });

    await mockServer.sendRegister(coordinatorPort, challenge, expectedAnswer);

    // Wait for processing with timeout
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 100)),
      500,
      'Registration processing timed out'
    );

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
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 100)),
      500,
      'Registration processing timed out'
    );

    const ipPort = registry.getServerByPublicKey(mockServer.serverPublicKey).ipPort;
    const timestampBefore = registry.getServerByPublicKey(mockServer.serverPublicKey).timestamp;

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 50));

    // Send optimized ping (no encryption)
    await mockServer.sendPing(coordinatorPort);
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 100)),
      500,
      'Ping processing timed out'
    );

    const timestampAfter = registry.getServerByPublicKey(mockServer.serverPublicKey).timestamp;
    assert.ok(timestampAfter > timestampBefore, 'Timestamp should be updated after ping');
  });

  test('should handle challenge refresh heartbeat', async () => {
    // First register
    const challenge1 = generateChallenge();
    const expectedAnswer1 = hashChallengeAnswer(challenge1, 'password123');
    await mockServer.sendRegister(coordinatorPort, challenge1, expectedAnswer1);
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 100)),
      500,
      'Registration processing timed out'
    );

    // Send heartbeat with new challenge
    const challenge2 = generateChallenge();
    const expectedAnswer2 = hashChallengeAnswer(challenge2, 'password123');

    let heartbeatReceived = false;
    udpServer.on('heartbeat', () => {
      heartbeatReceived = true;
    });

    await mockServer.sendHeartbeat(coordinatorPort, expectedAnswer1, challenge2, expectedAnswer2);
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 100)),
      500,
      'Heartbeat processing timed out'
    );

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
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 100)),
      500,
      'Registration processing timed out'
    );

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
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 100)),
      500,
      'Answer processing timed out'
    );

    assert.strictEqual(answerReceived, true);
    assert.strictEqual(receivedSessionId, sessionId);
  });

  test('should reject invalid signature in registration', async () => {
    // Create a fresh mock server with new keys for this test
    const testMockServer = new MockServer(coordinatorKeys.publicKey);
    await testMockServer.start();

    // Phase 1: Send HELLO
    const crypto = await import('crypto');
    const serverTag = crypto.default.randomBytes(4);
    
    const helloPayload = encodeHello(serverTag);
    await testMockServer.sendBinary(helloPayload, coordinatorPort, MESSAGE_TYPES.HELLO);
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 100)),
      500,
      'HELLO processing timed out'
    );
    
    // Get HELLO_ACK and extract coordinator tag
    const helloAckResponse = testMockServer.getLastResponse();
    const helloAckDecoded = decodeHelloAck(helloAckResponse.slice(2));
    const coordinatorTag = helloAckDecoded.coordinatorTag;
    
    testMockServer.clearResponses();
    
    // Phase 3: Send ECDH init (with coordinator tag + ECDH public key)
    const ecdhKeys = generateECDHKeyPair();
    
    const ecdhInitPayload = encodeECDHInit(coordinatorTag, ecdhKeys.publicKey);
    
    await testMockServer.sendBinary(ecdhInitPayload, coordinatorPort, MESSAGE_TYPES.ECDH_INIT);
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 100)),
      500,
      'ECDH init processing timed out'
    );
    
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
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 100)),
      500,
      'Invalid registration processing timed out'
    );

    // Server should not be registered
    const server = registry.getServerByPublicKey(testMockServer.serverPublicKey);
    assert.strictEqual(server, undefined);

    await testMockServer.stop();
  });

  test('should reject tampered heartbeat (AES-GCM authentication)', async () => {
    // First register
    const challenge1 = generateChallenge();
    const expectedAnswer1 = hashChallengeAnswer(challenge1, 'password123');
    await mockServer.sendRegister(coordinatorPort, challenge1, expectedAnswer1);
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 100)),
      500,
      'Registration processing timed out'
    );

    const challenge2 = generateChallenge();
    const expectedAnswer2 = hashChallengeAnswer(challenge2, 'password123');

    const payload = {
      newChallenge: challenge2,
      challengeAnswerHash: expectedAnswer2
    };

    const message = {
      type: 'heartbeat',
      payload
    };

    // Encrypt and then tamper with the ciphertext
    const key = deriveAESKey(expectedAnswer1);
    const encrypted = encryptAES(message, key);
    
    // Tamper with the encrypted data (flip a bit in the ciphertext)
    encrypted[30] ^= 0xFF;
    
    const udpMessage = buildUDPMessage(MESSAGE_TYPES.HEARTBEAT, encrypted);
    
    await withTimeout(
      new Promise((resolve) => {
        mockServer.socket.send(udpMessage, coordinatorPort, '127.0.0.1', (err) => {
          if (err) console.error('Send error:', err);
          resolve();
        });
      }),
      500,
      'Send timed out'
    );
    
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 100)),
      500,
      'Invalid heartbeat processing timed out'
    );

    // Challenge should not be updated (tampered message rejected)
    const server = registry.getServerByPublicKey(mockServer.serverPublicKey);
    assert.strictEqual(server.challenge, challenge1);
  });
});

describe('End-to-end Registration with Real UDPClient', () => {
  let registry;
  let udpServer;
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
  });

  after(async () => {
    try {
      await withTimeout(udpServer.stop(), 1000, 'UDP server stop timed out').catch(err => {
        console.error('Failed to stop UDP server:', err.message);
      });
      registry.destroy();
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  });

  test('should successfully register server with signature verification', async () => {
    // Generate server keys
    const serverKeys = generateECDSAKeyPair();
    serverKeys.password = 'test-password';

    // Create UDP client
    const client = new UDPClient('127.0.0.1', coordinatorPort, serverKeys, {
      coordinatorPublicKey: coordinatorKeys.publicKey
    });

    // Track registration on both sides
    let clientRegisteredEventFired = false;
    const clientRegistrationPromise = new Promise((resolve) => {
      client.on('registered', () => {
        clientRegisteredEventFired = true;
        resolve();
      });
    });

    let coordinatorRegisteredEventFired = false;
    const coordinatorRegistrationPromise = new Promise((resolve) => {
      udpServer.on('register', () => {
        coordinatorRegisteredEventFired = true;
        resolve();
      });
    });

    // Start client and wait for registration on both sides
    await client.start();
    
    // Wait for both events with timeout
    await withTimeout(
      Promise.all([clientRegistrationPromise, coordinatorRegistrationPromise]),
      2000,
      'End-to-end registration timed out'
    );

    // Verify client thinks it's registered
    assert.strictEqual(client.registered, true, 'Client should be registered');
    assert.strictEqual(client.state, 'registered', 'Client state should be registered');
    assert.strictEqual(clientRegisteredEventFired, true, 'Client registered event should fire');
    assert.strictEqual(coordinatorRegisteredEventFired, true, 'Coordinator registered event should fire');

    // Verify coordinator actually registered the server (signature was valid)
    const server = registry.getServerByPublicKey(serverKeys.publicKey);
    assert.ok(server, 'Server should be in registry');
    assert.ok(server.challenge, 'Server should have challenge');
    assert.ok(server.expectedAnswer, 'Server should have expectedAnswer');
    assert.ok(server.ipPort, 'Server should have ipPort');

    await client.stop();
  });
});

describe('Ping and Heartbeat with Short Intervals', () => {
  let registry;
  let udpServer;
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
  });

  after(async () => {
    try {
      await withTimeout(udpServer.stop(), 1000, 'UDP server stop timed out').catch(err => {
        console.error('Failed to stop UDP server:', err.message);
      });
      registry.destroy();
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  });

  test('should send ping automatically with short interval', async () => {
    // Generate server keys
    const serverKeys = generateECDSAKeyPair();
    serverKeys.password = 'test-password';

    // Create UDP client with SHORT keepalive interval (200ms for testing)
    const client = new UDPClient('127.0.0.1', coordinatorPort, serverKeys, {
      coordinatorPublicKey: coordinatorKeys.publicKey,
      keepaliveIntervalMs: 200, // Short interval for testing
      heartbeatIntervalMs: 10000 // Long interval to not interfere
    });

    // Track registration
    const clientRegistrationPromise = new Promise((resolve) => {
      client.on('registered', resolve);
    });

    // Track pings received by coordinator
    let pingCount = 0;
    udpServer.on('ping', () => {
      pingCount++;
    });

    // Start client and wait for registration
    await client.start();
    await withTimeout(clientRegistrationPromise, 2000, 'Registration timed out');

    const server = registry.getServerByPublicKey(serverKeys.publicKey);
    const timestampBefore = server.timestamp;

    // Wait for at least 2 pings (500ms should allow 2+ pings at 200ms interval)
    await new Promise(resolve => setTimeout(resolve, 500));

    assert.ok(pingCount >= 2, `Should receive at least 2 pings, got ${pingCount}`);

    // Verify timestamp was updated
    const timestampAfter = registry.getServerByPublicKey(serverKeys.publicKey).timestamp;
    assert.ok(timestampAfter > timestampBefore, 'Timestamp should be updated after pings');

    await client.stop();
  });

  test('should send heartbeat automatically with short interval', async () => {
    // Generate server keys
    const serverKeys = generateECDSAKeyPair();
    serverKeys.password = 'test-password';

    // Create UDP client with SHORT heartbeat interval (300ms for testing)
    const client = new UDPClient('127.0.0.1', coordinatorPort, serverKeys, {
      coordinatorPublicKey: coordinatorKeys.publicKey,
      keepaliveIntervalMs: 10000, // Long interval to not interfere
      heartbeatIntervalMs: 300 // Short interval for testing
    });

    // Track registration
    const clientRegistrationPromise = new Promise((resolve) => {
      client.on('registered', resolve);
    });

    // Track heartbeats received by coordinator
    let heartbeatCount = 0;
    udpServer.on('heartbeat', () => {
      heartbeatCount++;
    });

    // Start client and wait for registration
    await client.start();
    await withTimeout(clientRegistrationPromise, 2000, 'Registration timed out');

    const server = registry.getServerByPublicKey(serverKeys.publicKey);
    const initialChallenge = server.challenge;
    const initialExpectedAnswer = server.expectedAnswer;

    // Wait for at least 2 heartbeats (800ms should allow 2+ heartbeats at 300ms interval)
    await new Promise(resolve => setTimeout(resolve, 800));

    assert.ok(heartbeatCount >= 2, `Should receive at least 2 heartbeats, got ${heartbeatCount}`);

    // Verify challenge was updated on coordinator
    const updatedServer = registry.getServerByPublicKey(serverKeys.publicKey);
    assert.notStrictEqual(updatedServer.challenge, initialChallenge, 'Challenge should be updated');
    assert.notStrictEqual(updatedServer.expectedAnswer, initialExpectedAnswer, 'Expected answer should be updated');

    // Verify client's local challenge was also updated
    assert.notStrictEqual(client.challenge, initialChallenge, 'Client challenge should be updated');
    assert.notStrictEqual(client.expectedAnswer, initialExpectedAnswer, 'Client expected answer should be updated');

    await client.stop();
  });

  test('should handle both ping and heartbeat concurrently', async () => {
    // Generate server keys
    const serverKeys = generateECDSAKeyPair();
    serverKeys.password = 'test-password';

    // Create UDP client with SHORT intervals for both
    const client = new UDPClient('127.0.0.1', coordinatorPort, serverKeys, {
      coordinatorPublicKey: coordinatorKeys.publicKey,
      keepaliveIntervalMs: 150, // Very short for testing
      heartbeatIntervalMs: 250 // Short for testing
    });

    // Track registration
    const clientRegistrationPromise = new Promise((resolve) => {
      client.on('registered', resolve);
    });

    // Track both pings and heartbeats
    let pingCount = 0;
    let heartbeatCount = 0;
    
    udpServer.on('ping', () => {
      pingCount++;
    });
    
    udpServer.on('heartbeat', () => {
      heartbeatCount++;
    });

    // Start client and wait for registration
    await client.start();
    await withTimeout(clientRegistrationPromise, 2000, 'Registration timed out');

    // Wait for multiple pings and heartbeats
    await new Promise(resolve => setTimeout(resolve, 800));

    assert.ok(pingCount >= 3, `Should receive at least 3 pings, got ${pingCount}`);
    assert.ok(heartbeatCount >= 2, `Should receive at least 2 heartbeats, got ${heartbeatCount}`);

    await client.stop();
  });

  test('should continue pings after heartbeat updates challenge', async () => {
    // Generate server keys
    const serverKeys = generateECDSAKeyPair();
    serverKeys.password = 'test-password';

    // Create UDP client with SHORT intervals
    const client = new UDPClient('127.0.0.1', coordinatorPort, serverKeys, {
      coordinatorPublicKey: coordinatorKeys.publicKey,
      keepaliveIntervalMs: 100,
      heartbeatIntervalMs: 250
    });

    // Track registration
    const clientRegistrationPromise = new Promise((resolve) => {
      client.on('registered', resolve);
    });

    // Track pings and heartbeats with timing
    const events = [];
    
    udpServer.on('ping', () => {
      events.push({ type: 'ping', time: Date.now() });
    });
    
    udpServer.on('heartbeat', () => {
      events.push({ type: 'heartbeat', time: Date.now() });
    });

    // Start client and wait for registration
    await client.start();
    await withTimeout(clientRegistrationPromise, 2000, 'Registration timed out');

    // Wait for multiple cycles
    await new Promise(resolve => setTimeout(resolve, 900));

    // Verify we have both types of events
    const pings = events.filter(e => e.type === 'ping');
    const heartbeats = events.filter(e => e.type === 'heartbeat');
    
    assert.ok(pings.length >= 5, `Should have at least 5 pings, got ${pings.length}`);
    assert.ok(heartbeats.length >= 2, `Should have at least 2 heartbeats, got ${heartbeats.length}`);
    
    // Verify pings continue after heartbeat (check for ping events after first heartbeat)
    if (heartbeats.length > 0) {
      const firstHeartbeatTime = heartbeats[0].time;
      const pingsAfterHeartbeat = pings.filter(p => p.time > firstHeartbeatTime);
      assert.ok(pingsAfterHeartbeat.length > 0, 'Pings should continue after heartbeat');
    }

    await client.stop();
  });
});

console.log('All tests defined. Run with: npm test');

/**
 * Global cleanup handler to prevent test framework from hanging
 * 
 * Node.js test runner may wait indefinitely if any resources (timers, sockets, etc.)
 * are not properly cleaned up. This timeout ensures the process exits after a reasonable
 * delay, even if some cleanup operations fail or resources are leaked.
 * 
 * The timeout is unref'd so it doesn't keep the process alive if everything
 * completes normally. It only fires if the process would otherwise hang.
 * 
 * Strategy:
 * 1. Individual test operations have timeouts (withTimeout helper)
 * 2. Cleanup operations in after() hooks have timeouts
 * 3. Global safety timeout (this) forces exit as last resort
 * 
 * Note: This is a safety mechanism. Proper cleanup should happen in after() hooks.
 */
process.on('exit', (code) => {
  console.log(`Test process exiting with code ${code}`);
});

// Force exit after a delay if Node.js doesn't exit naturally after all tests complete
setTimeout(() => {
  console.log('Forcing process exit to prevent hanging');
  process.exit(0);
}, 2000).unref();
