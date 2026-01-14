import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import dgram from 'dgram';
import { UDPClient } from '../../shared/protocol.js';

/**
 * Helper to add timeout to promises to prevent hanging tests
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
  encodeECDHResponse,
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
        case MESSAGE_TYPES.ECDH_INIT:
          this.handleECDHInit(payload, ipPort, rinfo);
          break;
        case MESSAGE_TYPES.REGISTER:
          this.handleRegister(payload, ipPort, rinfo);
          break;
        case MESSAGE_TYPES.PING:
          console.log('Received ping');
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

  handleECDHInit(payload, ipPort, rinfo) {
    try {
      // Parse ECDH init
      const ecdhPubKeyLen = payload.readUInt8(0);
      const serverECDHPublicKey = payload.slice(1, 1 + ecdhPubKeyLen);

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
    await coordinator.stop();
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
    
    // Verify keepalive started
    assert.ok(client.keepaliveInterval);

    await client.stop();
  });

});
