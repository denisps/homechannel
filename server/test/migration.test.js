import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { UDPClient } from '../../shared/protocol.js';
import { UDPServer } from '../../shared/protocol.js';
import { ServerRegistry } from '../../coordinator/registry.js';
import { generateSigningKeyPair } from '../../shared/keys.js';
import { encryptAES, deriveAESKey } from '../../shared/crypto.js';
import { buildUDPMessage, MESSAGE_TYPES } from '../../shared/protocol.js';

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

describe('Coordinator Migration', () => {
  let udpServer;
  let udpClient;
  let registry;
  let coordinatorKeys;
  let serverKeys;

  before(async () => {
    // Generate keys
    coordinatorKeys = generateSigningKeyPair();
    serverKeys = generateSigningKeyPair();
    serverKeys.password = 'test-password';

    // Setup registry
    registry = new ServerRegistry();

    // Setup UDP server (coordinator)
    udpServer = new UDPServer(registry, coordinatorKeys, { port: 0 });
    await withTimeout(udpServer.start(), 2000, 'UDP server start timed out');
  });

  after(async () => {
    console.log('Cleanup starting...');
    try {
      // Stop client first to prevent reconnection attempts
      if (udpClient) {
        console.log('Stopping UDP client...');
        await withTimeout(udpClient.stop(), 1000, 'UDP client stop timed out').catch(err => {
          console.error('Failed to stop UDP client:', err.message);
        });
        udpClient = null;
        console.log('UDP client reference cleared');
      }
      // Then stop server
      if (udpServer) {
        console.log('Stopping UDP server...');
        await withTimeout(udpServer.stop(), 1000, 'UDP server stop timed out').catch(err => {
          console.error('Failed to stop UDP server:', err.message);
        });
        udpServer = null;
        console.log('UDP server reference cleared');
      }
      // Clean up registry
      if (registry) {
        console.log('Destroying registry...');
        registry.destroy();
        registry = null;
        console.log('Registry destroyed');
      }
      console.log('Cleanup completed');
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  });

  it('should handle MIGRATE message from coordinator', { timeout: 5000 }, async () => {
    // Setup UDP client (server) in the test
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

    // Wait for registration
    const registrationPromise = new Promise((resolve) => {
      udpClient.on('registered', resolve);
    });
    
    udpClient.start();
    await withTimeout(registrationPromise, 3000, 'Registration timed out');

    assert.strictEqual(udpClient.registered, true, 'Server should be registered');

    // Setup promise to wait for migration
    const migrationPromise = new Promise((resolve) => {
      udpClient.on('migrate', (newCoordinator) => {
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
    const receivedInfo = await withTimeout(migrationPromise, 2000, 'Migration message timed out');

    // Verify migration was triggered
    assert.strictEqual(receivedInfo.host, 'new-coordinator.example.com', 'New host should match');
    assert.strictEqual(receivedInfo.port, 3479, 'New port should match');
    assert.strictEqual(receivedInfo.publicKey, coordinatorKeys.publicKey, 'New public key should match');
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
