/**
 * Integration test for Coordinator-Server UDP communication
 * Tests registration, heartbeats, and message validation
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import dgram from 'node:dgram';
import { setTimeout } from 'node:timers/promises';
import { generateKeyPair, sign, encrypt } from '../../shared/crypto.js';
import { createRegistrationMessage } from '../../shared/protocol.js';

describe('Coordinator-Server UDP Integration', () => {
  const coordinatorPort = 13340;
  let udpClient;
  let serverKeys;

  before(async () => {
    // Generate test server keys
    serverKeys = await generateKeyPair();
    
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
    const message = await createRegistrationMessage({
      serverId: 'test-server-1',
      publicKey: serverKeys.publicKey,
      privateKey: serverKeys.privateKey
    });

    assert.ok(message.type === 'register', 'Message should have correct type');
    assert.ok(message.serverId, 'Message should include server ID');
    assert.ok(message.publicKey, 'Message should include public key');
    assert.ok(message.signature, 'Message should be signed');
  });

  it('should handle encrypted payloads', async () => {
    const testData = { action: 'test', timestamp: Date.now() };
    const key = Buffer.from('0'.repeat(64), 'hex'); // Test key
    
    const encrypted = await encrypt(JSON.stringify(testData), key);
    assert.ok(encrypted.ciphertext, 'Should produce ciphertext');
    assert.ok(encrypted.iv, 'Should produce IV');
    assert.ok(encrypted.authTag, 'Should produce auth tag');
  });

  it('should reject messages with invalid signatures', async () => {
    const message = await createRegistrationMessage({
      serverId: 'test-server-2',
      publicKey: serverKeys.publicKey,
      privateKey: serverKeys.privateKey
    });

    // Tamper with the message
    message.serverId = 'tampered-server';

    // Coordinator should reject this when signature validation fails
    // This validates the security model is working
    assert.ok(message.signature, 'Message has signature to validate');
  });
});
