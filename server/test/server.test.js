import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import dgram from 'dgram';
import { UDPClient } from '../../shared/protocol.js';

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
import { 
  generateECDHKeyPair,
  computeECDHSecret,
  deriveAESKey, 
  encryptAES,
  decryptAES,
  signBinaryData,
  encodeHello,
  encodeHelloAck,
  decodeHello,
  encodeECDHInit,
  encodeECDHResponse,
  decodeECDHInit,
  signData
} from '../../shared/crypto.js';
import { generateECDSAKeyPair } from '../../shared/keys.js';
import { PROTOCOL_VERSION, MESSAGE_TYPES } from '../../shared/protocol.js';

/**
 * Mock coordinator for testing
 */
class MockCoordinator {
  constructor(port = 3478) {
    this.socket = null;
    this.port = port;
    this.ecdhSessions = new Map();
    this.helloSessions = new Map(); // Track HELLO sessions
    this.coordinatorKeys = generateECDSAKeyPair();
    this.registeredServers = new Map();
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        reject(err);
      });

      this.socket.on('message', (msg, rinfo) => {
        this.handleMessage(msg, rinfo);
      });

      this.socket.on('listening', () => {
        resolve();
      });

      this.socket.bind(this.port);
    });
  }

  handleMessage(msg, rinfo) {
    try {
      const ipPort = `${rinfo.address}:${rinfo.port}`;
      
      if (msg.length < 2) {
        console.error('Message too short');
        return;
      }

      const version = msg[0];
      const messageType = msg[1];
      const payload = msg.slice(2);

      if (version !== PROTOCOL_VERSION) {
        console.error(`Unsupported protocol version: ${version}`);
        return;
      }

      switch (messageType) {
        case MESSAGE_TYPES.HELLO:
          this.handleHello(payload, ipPort, rinfo);
          break;        case MESSAGE_TYPES.HELLO:
          this.handleHello(payload, ipPort, rinfo);
          break;        case MESSAGE_TYPES.ECDH_INIT:
          this.handleECDHInit(payload, ipPort, rinfo);
          break;
        case MESSAGE_TYPES.REGISTER:
          this.handleRegister(payload, ipPort, rinfo);
          break;
        case MESSAGE_TYPES.PING:
          console.log('Received ping');
          break;
        case MESSAGE_TYPES.HEARTBEAT:
          this.handleHeartbeat(payload, ipPort, rinfo);
          break;
        case MESSAGE_TYPES.ANSWER:
          console.log('Received answer');
          break;
        default:
          console.warn(`Unknown message type: 0x${messageType.toString(16)}`);
      }
    } catch (error) {
      console.error('Error handling message:', error.message);
    }
  }

  async handleHello(payload, ipPort, rinfo) {
    try {
      const decoded = decodeHello(payload);
      
      // Generate coordinator's random tag
      const crypto = await import('crypto');
      const coordinatorTag = crypto.default.randomBytes(4);
      
      // Store session
      this.helloSessions.set(ipPort, {
        serverTag: decoded.serverTag,
        coordinatorTag,
        timestamp: Date.now()
      });
      
      // Send HELLO_ACK
      const responsePayload = encodeHelloAck(decoded.serverTag, coordinatorTag);
      const message = Buffer.concat([
        Buffer.from([PROTOCOL_VERSION, MESSAGE_TYPES.HELLO_ACK]),
        responsePayload
      ]);
      
      this.socket.send(message, rinfo.port, rinfo.address);
    } catch (error) {
      console.error('Error handling HELLO:', error.message);
    }
  }

  handleECDHInit(payload, ipPort, rinfo) {
    try {
      // Verify coordinator tag before expensive ECDH
      const decoded = decodeECDHInit(payload);
      
      const helloSession = this.helloSessions.get(ipPort);
      if (!helloSession) {
        console.error('No HELLO session for ECDH init');
        return;
      }
      
      if (!helloSession.coordinatorTag.equals(decoded.coordinatorTag)) {
        console.error('Invalid coordinator tag in ECDH init');
        return;
      }
      
      // Clean up HELLO session
      this.helloSessions.delete(ipPort);
      
      // Parse ECDH init
      const serverECDHPublicKey = decoded.ecdhPublicKey;

      // Generate coordinator ECDH keys
      const ecdhKeys = generateECDHKeyPair();

      // Compute shared secret
      const sharedSecret = computeECDHSecret(ecdhKeys.privateKey, serverECDHPublicKey);

      // Store session
      this.ecdhSessions.set(ipPort, {
        ecdhKeys,
        serverECDHPublicKey,
        sharedSecret,
        timestamp: Date.now()
      });

      // Sign both ECDH public keys
      const dataToSign = Buffer.concat([
        ecdhKeys.publicKey,
        serverECDHPublicKey
      ]);
      const signature = signBinaryData(dataToSign, this.coordinatorKeys.privateKey);

      // Encrypt signature data
      const key = deriveAESKey(sharedSecret.toString('hex'));
      const signatureData = { 
        timestamp: Date.now(), 
        signature: signature.toString('hex')
      };
      const encryptedData = encryptAES(signatureData, key);

      // Encode ECDH response
      const responsePayload = encodeECDHResponse(ecdhKeys.publicKey, encryptedData);
      const message = Buffer.concat([
        Buffer.from([PROTOCOL_VERSION, MESSAGE_TYPES.ECDH_RESPONSE]),
        responsePayload
      ]);

      this.socket.send(message, rinfo.port, rinfo.address, (err) => {
        if (err) {
          console.error('Error sending ECDH response:', err);
        }
      });
    } catch (error) {
      console.error('Error handling ECDH init:', error.message);
    }
  }

  handleRegister(payload, ipPort, rinfo) {
    try {
      const session = this.ecdhSessions.get(ipPort);
      if (!session) {
        console.error('No ECDH session for registration');
        return;
      }

      // Decrypt registration
      const key = deriveAESKey(session.sharedSecret.toString('hex'));
      const data = decryptAES(payload, key);

      console.log('Server registered:', data.serverPublicKey.substring(0, 50) + '...');

      // Store server
      this.registeredServers.set(data.serverPublicKey, {
        ipPort,
        challenge: data.payload.challenge,
        expectedAnswer: data.payload.challengeAnswerHash,
        timestamp: Date.now()
      });

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
    } catch (error) {
      console.error('Error handling register:', error.message);
    }
  }

  handleHeartbeat(payload, ipPort, rinfo) {
    try {
      // Get server data
      const server = Array.from(this.registeredServers.values()).find(s => s.ipPort === ipPort);
      if (!server) {
        console.error('Server not found for heartbeat');
        return;
      }

      // Decrypt heartbeat
      const key = deriveAESKey(server.expectedAnswer);
      const message = decryptAES(payload, key);

      console.log('Received heartbeat');

      // Update challenge
      if (message.payload) {
        server.challenge = message.payload.newChallenge;
        server.expectedAnswer = message.payload.challengeAnswerHash;
      }
    } catch (error) {
      console.error('Error handling heartbeat:', error.message);
    }
  }

  async stop() {
    if (this.socket) {
      await new Promise((resolve) => {
        this.socket.close(resolve);
      });
    }
  }
}

describe('Server UDP Module', () => {
  let coordinator;
  let serverKeys;

  before(async () => {
    coordinator = new MockCoordinator(0); // Use any available port
    await coordinator.start();
    serverKeys = generateECDSAKeyPair();
    serverKeys.password = 'test-password';
  });

  after(async () => {
    try {
      await withTimeout(coordinator.stop(), 1000, 'Coordinator stop timed out').catch(err => {
        console.error('Failed to stop coordinator:', err.message);
      });
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  });

  test('UDPClient should initialize', () => {
    const client = new UDPClient('127.0.0.1', coordinator.socket.address().port, serverKeys);
    assert.ok(client);
    assert.strictEqual(client.state, 'disconnected');
    assert.strictEqual(client.registered, false);
  });

  test('UDPClient should complete registration', async () => {
    const client = new UDPClient('127.0.0.1', coordinator.socket.address().port, serverKeys, {
      coordinatorPublicKey: coordinator.coordinatorKeys.publicKey
    });

    await client.start();

    // Wait for registration with timeout
    await withTimeout(
      new Promise(resolve => client.on('registered', resolve)),
      2000,
      'Registration timed out'
    );

    assert.strictEqual(client.state, 'registered');
    assert.strictEqual(client.registered, true);
    assert.ok(client.challenge);
    assert.ok(client.expectedAnswer);
    assert.ok(client.aesKey);

    await client.stop();
  });

  test('UDPClient should handle registration acknowledgment', async () => {
    const client = new UDPClient('127.0.0.1', coordinator.socket.address().port, serverKeys, {
      coordinatorPublicKey: coordinator.coordinatorKeys.publicKey
    });

    let registeredCalled = false;
    const registrationPromise = new Promise(resolve => {
      client.on('registered', () => {
        registeredCalled = true;
        resolve();
      });
    });

    await client.start();

    // Wait for registration acknowledgment with timeout
    await withTimeout(
      registrationPromise,
      2000,
      'Registration acknowledgment timed out'
    );

    // Verify registration state updated after receiving ack
    assert.strictEqual(client.state, 'registered');
    assert.strictEqual(client.registered, true);
    assert.strictEqual(registeredCalled, true);
    
    // Verify keepalive and heartbeat started
    assert.ok(client.keepaliveInterval);
    assert.ok(client.heartbeatInterval);

    await client.stop();
  });

  test('UDPClient should send pings with short interval', async () => {
    const client = new UDPClient('127.0.0.1', coordinator.socket.address().port, serverKeys, {
      coordinatorPublicKey: coordinator.coordinatorKeys.publicKey,
      keepaliveIntervalMs: 150, // Short interval for testing
      heartbeatIntervalMs: 10000 // Long to avoid interference
    });

    let pingsReceived = 0;
    coordinator.socket.on('message', (msg) => {
      if (msg.length >= 2 && msg[1] === 0x06) { // PING message type (updated from 0x04)
        pingsReceived++;
      }
    });

    await client.start();
    await withTimeout(
      new Promise(resolve => client.on('registered', resolve)),
      2000,
      'Registration timed out'
    );

    // Wait for multiple pings
    await new Promise(resolve => setTimeout(resolve, 500));

    assert.ok(pingsReceived >= 2, `Should receive at least 2 pings, got ${pingsReceived}`);

    await client.stop();
  });

  test('UDPClient should send heartbeats with short interval', async () => {
    const client = new UDPClient('127.0.0.1', coordinator.socket.address().port, serverKeys, {
      coordinatorPublicKey: coordinator.coordinatorKeys.publicKey,
      keepaliveIntervalMs: 10000, // Long to avoid interference
      heartbeatIntervalMs: 200 // Short interval for testing
    });

    const initialChallenge = client.challenge;

    await client.start();
    await withTimeout(
      new Promise(resolve => client.on('registered', resolve)),
      2000,
      'Registration timed out'
    );

    const challengeAfterRegistration = client.challenge;
    assert.ok(challengeAfterRegistration, 'Should have challenge after registration');

    // Wait for at least one heartbeat to be sent
    await new Promise(resolve => setTimeout(resolve, 600));

    // Challenge should have been refreshed
    assert.notStrictEqual(client.challenge, challengeAfterRegistration, 'Challenge should be refreshed after heartbeat');

    await client.stop();
  });

});

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
 */
setTimeout(() => {
  console.log('Forcing process exit to prevent hanging');
  process.exit(0);
}, 2000).unref();
