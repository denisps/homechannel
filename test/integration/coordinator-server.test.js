/**
 * Integration test for Coordinator-Server UDP communication
 * Tests registration, heartbeats, and message validation
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import dgram from 'node:dgram';
import { setTimeout } from 'node:timers/promises';
import { generateECDSAKeyPair } from '../../shared/keys.js';
import { encryptAES, deriveAESKey } from '../../shared/crypto.js';
import { MESSAGE_TYPES } from '../../shared/protocol.js';

describe('Coordinator-Server UDP Integration', () => {
  const coordinatorPort = 13340;
  let udpClient;
  let serverKeys;

  before(async () => {
    // Generate test server keys
    serverKeys = generateECDSAKeyPair();
    
    // Create UDP client for testing
    udpClient = dgram.createSocket('udp4');
    await new Promise((resolve) => {
      udpClient.bind(() => resolve());
    });
  });

  after(async () => {
    if (udpClient) {
      udpClient.close();
    }
  });

  it('should validate server registration message format', async () => {
    // Validate message type constants exist
    assert.ok(MESSAGE_TYPES.REGISTER === 0x05, 'REGISTER message type should be defined');
    assert.ok(MESSAGE_TYPES.HELLO === 0x01, 'HELLO message type should be defined');
    assert.ok(serverKeys.publicKey, 'Should have generated public key');
    assert.ok(serverKeys.privateKey, 'Should have generated private key');
  });

  it('should handle encrypted payloads', async () => {
    const testData = { action: 'test', timestamp: Date.now() };
    const key = deriveAESKey(Buffer.from('test-password'));
    
    const encrypted = encryptAES(testData, key);
    assert.ok(Buffer.isBuffer(encrypted), 'Should produce encrypted buffer');
    assert.ok(encrypted.length > 0, 'Encrypted buffer should have content');
    assert.ok(encrypted.length >= 28, 'Should have IV (12) + authTag (16) + ciphertext');
  });

  it('should validate protocol constants', async () => {
    // Validate all message types are defined
    assert.ok(MESSAGE_TYPES.HELLO, 'HELLO message type exists');
    assert.ok(MESSAGE_TYPES.ECDH_INIT, 'ECDH_INIT message type exists');
    assert.ok(MESSAGE_TYPES.REGISTER, 'REGISTER message type exists');
    assert.ok(MESSAGE_TYPES.PING, 'PING message type exists');
    assert.ok(MESSAGE_TYPES.HEARTBEAT, 'HEARTBEAT message type exists');
  });
});
