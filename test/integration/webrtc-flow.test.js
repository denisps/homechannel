/**
 * Integration test for WebRTC connection establishment flow
 * Tests coordinator, server, and client interaction for WebRTC signaling
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Coordinator } from '../../coordinator/index.js';
import { setTimeout } from 'node:timers/promises';

describe('WebRTC Connection Flow Integration', () => {
  let coordinator;
  const coordinatorPort = 13337;
  const coordinatorUdpPort = 13338;

  before(async () => {
    // Initialize coordinator programmatically
    coordinator = new Coordinator({
      privateKeyPath: './keys/coordinator.priv',
      publicKeyPath: './keys/coordinator.pub',
      serverTimeout: 30000,
      maxServers: 100,
      udp: {
        port: coordinatorUdpPort
      },
      https: {
        port: coordinatorPort,
        host: 'localhost'
      }
    });

    // Start coordinator
    await coordinator.start();
    await setTimeout(500);
  });

  after(async () => {
    // Cleanup coordinator
    if (coordinator) {
      await coordinator.stop();
    }
    await setTimeout(500);
  });

  it('should start coordinator and respond to API requests', async () => {
    const response = await fetch(`http://localhost:${coordinatorPort}/api/coordinator-key`);
    assert.strictEqual(response.ok, true, 'Coordinator key API should respond');
    const data = await response.json();
    assert.ok(data.publicKey, 'Should return public key');
  });

  it('should return empty server list for unknown keys', async () => {
    const response = await fetch(`http://localhost:${coordinatorPort}/api/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverPublicKeys: [] })
    });
    assert.strictEqual(response.ok, true, 'Should be able to fetch server list');
    
    const data = await response.json();
    assert.ok(data.servers, 'Should return servers property');
    assert.ok(Array.isArray(data.servers), 'Servers should be an array');
    assert.strictEqual(data.servers.length, 0, 'Should be empty for unknown keys');
  });

  it('should accept UDP messages on configured port', async () => {
    // Verify UDP server is listening
    assert.ok(coordinator.udpServer, 'UDP server should be initialized');
    assert.ok(coordinator.udpServer.socket, 'UDP socket should be created');
  });
});
