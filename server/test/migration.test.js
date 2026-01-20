import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { UDPClient } from '../../shared/protocol.js';
import { UDPServer } from '../../shared/protocol.js';
import { ServerRegistry } from '../../coordinator/registry.js';
import { generateECDSAKeyPair } from '../../shared/keys.js';
import { encryptAES, deriveAESKey } from '../../shared/crypto.js';
import { buildUDPMessage, MESSAGE_TYPES } from '../../shared/protocol.js';

describe('Coordinator Migration', () => {
  let udpServer;
  let udpClient;
  let registry;
  let coordinatorKeys;
  let serverKeys;
  let migrationTriggered = false;
  let newCoordinatorInfo = null;

  before(async () => {
    // Generate keys
    coordinatorKeys = generateECDSAKeyPair();
    serverKeys = generateECDSAKeyPair();
    serverKeys.password = 'test-password';

    // Setup registry
    registry = new ServerRegistry();

    // Setup UDP server (coordinator)
    udpServer = new UDPServer(registry, coordinatorKeys, { port: 0 });
    await udpServer.start();

    // Setup UDP client (server)
    udpClient = new UDPClient(
      '127.0.0.1',
      udpServer.socket.address().port,
      serverKeys,
      { 
        coordinatorPublicKey: coordinatorKeys.publicKey,
        keepaliveIntervalMs: 1000,
        heartbeatIntervalMs: 5000
      }
    );

    // Listen for migration events
    udpClient.on('migrate', (newCoordinator) => {
      migrationTriggered = true;
      newCoordinatorInfo = newCoordinator;
    });
  });

  after(async () => {
    try {
      if (udpClient) {
        await Promise.race([
          udpClient.stop(),
          new Promise((resolve) => setTimeout(resolve, 1000))
        ]);
      }
      if (udpServer) {
        await Promise.race([
          udpServer.stop(),
          new Promise((resolve) => setTimeout(resolve, 1000))
        ]);
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  it('should handle MIGRATE message from coordinator', async () => {
    // First, register the server
    await new Promise((resolve) => {
      udpClient.on('registered', resolve);
      udpClient.start();
    });

    assert.strictEqual(udpClient.registered, true, 'Server should be registered');

    // Setup promise to wait for migration
    const migrationPromise = new Promise((resolve) => {
      const originalHandler = udpClient.handlers.get('migrate');
      udpClient.on('migrate', (newCoordinator) => {
        if (originalHandler) originalHandler(newCoordinator);
        resolve(newCoordinator);
      });
    });

    // Simulate coordinator sending MIGRATE message
    const migratePayload = {
      type: 'migrate',
      payload: {
        host: 'new-coordinator.example.com',
        port: 3479,
        publicKey: coordinatorKeys.publicKey // Use same key for test
      }
    };

    // Encrypt with current AES key
    const encryptedPayload = encryptAES(migratePayload, udpClient.aesKey);
    const message = buildUDPMessage(MESSAGE_TYPES.MIGRATE, encryptedPayload);

    // Send MIGRATE message to client
    udpServer.socket.send(
      message,
      udpClient.socket.address().port,
      '127.0.0.1'
    );

    // Wait for migration with timeout
    const receivedInfo = await Promise.race([
      migrationPromise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Migration timeout')), 2000)
      )
    ]);

    // Verify migration was triggered
    assert.strictEqual(receivedInfo.host, 'new-coordinator.example.com', 'New host should match');
    assert.strictEqual(receivedInfo.port, 3479, 'New port should match');
    assert.strictEqual(receivedInfo.publicKey, coordinatorKeys.publicKey, 'New public key should match');
  });
});
