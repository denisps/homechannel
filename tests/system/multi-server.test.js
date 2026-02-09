/**
 * System Test: Multi-Server Concurrent Connections
 * 
 * Tests the coordinator's ability to handle multiple servers connecting simultaneously.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { UDPClient, UDPServer } from '../../shared/protocol.js';
import { ServerRegistry } from '../../coordinator/registry.js';
import { generateSigningKeyPair } from '../../shared/keys.js';
import { cleanupClient, createPingCounter } from '../utils/test-helpers.js';

describe('System Test: Multi-Server Connections', () => {
  let coordinatorKeys;
  let udpServer;
  let registry;
  let coordinatorPort;
  let clients = [];

  before(async () => {
    // Start real coordinator
    coordinatorKeys = generateSigningKeyPair();
    registry = new ServerRegistry();
    udpServer = new UDPServer(registry, coordinatorKeys, { port: 0 });
    await udpServer.start();
    coordinatorPort = udpServer.socket.address().port;
  });

  after(async () => {
    // Cleanup all clients using shared utility
    for (const client of clients) {
      await cleanupClient(client);
    }
    
    // Stop coordinator
    if (udpServer) {
      try {
        await udpServer.stop();
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });

  test('should handle 5 concurrent server registrations', async () => {
    const registrationPromises = [];

    for (let i = 0; i < 5; i++) {
      const serverKeys = generateSigningKeyPair();
      const client = new UDPClient(
        'localhost',
        coordinatorPort,
        serverKeys,
        { 
          coordinatorPublicKey: coordinatorKeys.publicKey,
          keepaliveIntervalMs: 500, // Short interval for testing keepalive
          heartbeatIntervalMs: 60000 // Long interval to avoid interference
        }
      );
      
      clients.push(client);
      
      const registrationPromise = new Promise((resolve) => {
        client.on('registered', resolve);
      });
      
      registrationPromises.push(
        client.start().then(() => registrationPromise)
      );
    }

    // Wait for all registrations to complete
    await Promise.all(registrationPromises.map(p => 
      Promise.race([
        p,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Registration timeout')), 10000)
        )
      ])
    ));

    // Verify all servers are registered
    const stats = registry.getStats();
    assert.ok(stats.totalServers >= 5, `Should have at least 5 servers registered, got ${stats.totalServers}`);
  });

  test('should maintain all connections with keepalive', async () => {
    // Use shared ping counter utility
    const pingCounter = createPingCounter(udpServer);

    // Wait for keepalive pings (with short interval set by clients)
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Restore original handler
    pingCounter.restore();

    // Verify actual ping messages were received from clients (not just checking socket state)
    const totalPingsReceived = pingCounter.getTotalPings();
    
    // Each client should have sent at least one ping during the 2 second wait
    assert.ok(
      totalPingsReceived >= clients.length,
      `Should receive at least ${clients.length} total pings (one per client), got ${totalPingsReceived}`
    );

    // All clients should still be running
    for (const client of clients) {
      assert.ok(!client.socket?.destroyed, 'Client socket should still be active');
    }

    // All servers should still be in registry
    const stats = registry.getStats();
    assert.ok(stats.totalServers >= 5, 'All servers should still be registered');
  });

  test('should handle server disconnection gracefully', async () => {
    // Disconnect one server using shared utility
    const clientToDisconnect = clients[0];
    await cleanupClient(clientToDisconnect);

    // Wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Other servers should still be registered
    const stats = registry.getStats();
    assert.ok(stats.totalServers >= 4, 'Other servers should remain registered');
  });
});
