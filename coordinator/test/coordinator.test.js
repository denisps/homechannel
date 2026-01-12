import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import dgram from 'dgram';
import { ServerRegistry } from '../registry.js';
import { UDPServer } from '../udp.js';
import { generateECDSAKeyPair, signData, verifySignature, createHMAC, generateChallenge, hashChallengeAnswer } from '../crypto.js';

/**
 * Mock server for testing
 */
class MockServer {
  constructor() {
    this.socket = dgram.createSocket('udp4');
    this.keys = generateECDSAKeyPair();
    this.serverPublicKey = this.keys.publicKey;
    this.serverPrivateKey = this.keys.privateKey;
    this.coordinatorPort = 0;
    this.responses = [];
  }

  async start() {
    return new Promise((resolve) => {
      this.socket.on('message', (msg) => {
        this.responses.push(JSON.parse(msg.toString()));
      });

      this.socket.bind(() => {
        resolve(this.socket.address().port);
      });
    });
  }

  sendRegister(coordinatorPort, challenge, expectedAnswer) {
    const payload = {
      challenge,
      challengeAnswerHash: expectedAnswer
    };

    const message = {
      type: 'register',
      serverPublicKey: this.serverPublicKey,
      timestamp: Date.now(),
      payload,
      signature: signData({ serverPublicKey: this.serverPublicKey, timestamp: Date.now(), payload }, this.serverPrivateKey)
    };

    return this.send(message, coordinatorPort);
  }

  sendPing(coordinatorPort) {
    const message = { type: 'ping' };
    return this.send(message, coordinatorPort);
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

    return this.send(message, coordinatorPort);
  }

  sendAnswer(coordinatorPort, sessionId, sdp, candidates) {
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

    return this.send(message, coordinatorPort);
  }

  send(message, coordinatorPort) {
    return new Promise((resolve, reject) => {
      const buffer = Buffer.from(JSON.stringify(message));
      this.socket.send(buffer, coordinatorPort, 'localhost', (err) => {
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

    // Create and start mock server
    mockServer = new MockServer();
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

    // Send ping
    await mockServer.sendPing(coordinatorPort);
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

    await mockServer.sendAnswer(coordinatorPort, sessionId, sdp, candidates);
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.strictEqual(answerReceived, true);
    assert.strictEqual(receivedSessionId, sessionId);
  });

  test('should reject invalid signature in registration', async () => {
    // Create a fresh mock server with new keys for this test
    const testMockServer = new MockServer();
    await testMockServer.start();

    const challenge = generateChallenge();
    const expectedAnswer = hashChallengeAnswer(challenge, 'password123');

    // Create message with wrong signature
    const payload = {
      challenge,
      challengeAnswerHash: expectedAnswer
    };

    const message = {
      type: 'register',
      serverPublicKey: testMockServer.serverPublicKey,
      timestamp: Date.now(),
      payload,
      signature: 'invalid-signature'
    };

    await testMockServer.send(message, coordinatorPort);
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

    await mockServer.send(message, coordinatorPort);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Challenge should not be updated
    const server = registry.getServerByPublicKey(mockServer.serverPublicKey);
    assert.strictEqual(server.challenge, challenge1);
  });
});

console.log('All tests defined. Run with: npm test');
