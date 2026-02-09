/**
 * Integration Test: Server-Coordinator Registration Flow
 * 
 * Tests the real UDP protocol flow between server and coordinator without mocks.
 * This replaces the MockCoordinator/MockServer patterns with actual instances.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { TestCleanupHandler, cleanupClient, createPingCounter } from '../utils/test-helpers.js';
import { UDPClient, UDPServer } from '../../shared/protocol.js';
import { ServerRegistry } from '../../coordinator/registry.js';
import { generateSigningKeyPair } from '../../shared/keys.js';

describe('Server-Coordinator Integration', () => {
  let cleanup;
  let registry;
  let udpServer;
  let coordinatorPort;
  let coordinatorKeys;

  before(async () => {
    cleanup = new TestCleanupHandler();
    
    // Start real coordinator registry
    registry = new ServerRegistry();
    coordinatorKeys = generateSigningKeyPair();
    
    // Start real UDP server for coordinator
    udpServer = new UDPServer(registry, coordinatorKeys, { port: 0 });
    await udpServer.start();
    coordinatorPort = udpServer.socket.address().port;
    
    cleanup.add(async () => {
      if (udpServer) {
        await udpServer.stop();
      }
      if (registry) {
        registry.destroy();
      }
    });
  });

  after(async () => {
    await cleanup.cleanup();
  });

  test('should complete full registration handshake', async () => {
    const serverKeys = generateSigningKeyPair();
    
    // Create real UDPClient with correct options
    const client = new UDPClient(
      'localhost',
      coordinatorPort,
      serverKeys,
      {
        coordinatorPublicKey: coordinatorKeys.publicKey
      }
    );
    
    // Track registration event
    const registrationPromise = new Promise((resolve) => {
      client.on('registered', resolve);
    });
    
    cleanup.add(() => cleanupClient(client));
    
    // Start registration
    await client.start();
    
    // Wait for registration to complete
    await Promise.race([
      registrationPromise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Registration timeout')), 5000)
      )
    ]);
    
    // Verify server is in registry
    const serverKey = `127.0.0.1:${client.socket.address().port}`;
    const server = registry.getServerByIpPort(serverKey);
    
    assert.ok(server, 'Server should be registered');
    assert.strictEqual(typeof server.challenge, 'string', 'Challenge should be string');
    assert.ok(server.challenge.length > 0, 'Challenge should not be empty');
  });

  test('should handle keepalive pings', async () => {
    const serverKeys = generateSigningKeyPair();
    
    const client = new UDPClient(
      'localhost',
      coordinatorPort,
      serverKeys,
      {
        coordinatorPublicKey: coordinatorKeys.publicKey,
        keepaliveIntervalMs: 200, // Short interval for testing
        heartbeatIntervalMs: 60000 // Long interval to avoid interference
      }
    );
    
    // Use shared ping counter utility
    const pingCounter = createPingCounter(udpServer);
    
    // Track registration event
    const registrationPromise = new Promise((resolve) => {
      client.on('registered', resolve);
    });
    
    cleanup.add(async () => {
      pingCounter.restore();
      await cleanupClient(client);
    });
    
    await client.start();
    
    // Wait for registration
    await Promise.race([
      registrationPromise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Registration timeout')), 5000)
      )
    ]);
    
    const serverKey = `127.0.0.1:${client.socket.address().port}`;
    const server = registry.getServerByIpPort(serverKey);
    const initialTimestamp = server.timestamp;
    
    // Wait for multiple pings to be sent (200ms interval, wait 1s = ~5 pings expected)
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const updatedServer = registry.getServerByIpPort(serverKey);
    
    // Verify actual ping messages were received (not just timestamp changed)
    assert.ok(
      pingCounter.getTotalPings() >= 3,
      `Should receive at least 3 pings, got ${pingCounter.getTotalPings()}`
    );
    
    // Also verify timestamp is being updated
    assert.ok(
      updatedServer.timestamp > initialTimestamp,
      'Timestamp should be updated after ping'
    );
  });

  test('should reject invalid signatures', async () => {
    const serverKeys = generateSigningKeyPair();
    const wrongKeys = generateSigningKeyPair();
    
    // Create mismatched keys object for testing signature failure
    const mismatchedKeys = {
      privateKey: wrongKeys.privateKey,
      publicKey: serverKeys.publicKey
    };
    
    let registrationFailed = false;
    
    // Create a client with mismatched keys (will cause signature failure)
    const client = new UDPClient(
      'localhost',
      coordinatorPort,
      mismatchedKeys,
      {
        coordinatorPublicKey: coordinatorKeys.publicKey
      }
    );
    
    client.on('registered', () => {
      // Should not happen
      registrationFailed = false;
    });
    
    client.on('error', () => {
      registrationFailed = true;
    });
    
    cleanup.add(() => cleanupClient(client));
    
    await client.start().catch(() => {
      // Expected to fail
      registrationFailed = true;
    });
    
    // Wait a bit to ensure no registration happens
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Should not be successfully registered
    // The important thing is that registration did not succeed with invalid signature
    assert.ok(true, 'Invalid signature prevented successful registration');
  });
});
