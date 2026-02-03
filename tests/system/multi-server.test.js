/**
 * System Test: Multi-Server Concurrent Connections
 * 
 * Tests the coordinator's ability to handle multiple servers connecting simultaneously.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { UDPClient, UDPServer } from '../../shared/protocol.js';
import { ServerRegistry } from '../../coordinator/registry.js';
import { generateECDSAKeyPair } from '../../shared/keys.js';

describe('System Test: Multi-Server Connections', () => {
  let coordinatorKeys;
  let udpServer;
  let registry;
  let coordinatorPort;
  let clients = [];

  before(async () => {
    // Start real coordinator
    coordinatorKeys = generateECDSAKeyPair();
    registry = new ServerRegistry();
    udpServer = new UDPServer(registry, coordinatorKeys, { port: 0 });
    await udpServer.start();
    coordinatorPort = udpServer.socket.address().port;
  });

  after(async () => {
    // Cleanup all clients
    for (const client of clients) {
      if (client.socket && !client.socket.destroyed) {
        try {
          client.socket.close();
        } catch (err) {
          // Ignore cleanup errors
        }
      }
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
      const serverKeys = generateECDSAKeyPair();
      const client = new UDPClient(
        'localhost',
        coordinatorPort,
        serverKeys,
        { coordinatorPublicKey: coordinatorKeys.publicKey }
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
    // Wait for a keepalive cycle
    await new Promise(resolve => setTimeout(resolve, 2000));

    // All clients should still be running
    for (const client of clients) {
      assert.ok(!client.socket?.destroyed, 'Client socket should still be active');
    }

    // All servers should still be in registry
    const stats = registry.getStats();
    assert.ok(stats.totalServers >= 5, 'All servers should still be registered');
  });

  test('should handle server disconnection gracefully', async () => {
    // Disconnect one server
    const clientToDisconnect = clients[0];
    clientToDisconnect.socket.close();

    // Wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Other servers should still be registered
    const stats = registry.getStats();
    assert.ok(stats.totalServers >= 4, 'Other servers should remain registered');
  });
});
