/**
 * System test for failover and recovery scenarios
 * Tests system resilience and error handling
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Coordinator } from '../../coordinator/index.js';
import { setTimeout } from 'node:timers/promises';

describe('Failover and Recovery System Test', () => {
  let coordinator;
  const coordinatorPort = 13344;

  before(async () => {
    // Start coordinator programmatically
    coordinator = new Coordinator({
      privateKeyPath: './keys/coordinator.priv',
      publicKeyPath: './keys/coordinator.pub',
      serverTimeout: 30000,
      maxServers: 100,
      udp: {
        port: 13347
      },
      https: {
        port: coordinatorPort,
        host: 'localhost'
      }
    });

    await coordinator.start();
    await setTimeout(500);
  });

  after(async () => {
    if (coordinator) {
      await coordinator.stop();
    }
    await setTimeout(500);
  });

  it('should handle coordinator restart gracefully', async () => {
    // Verify coordinator is running
    let response = await fetch(`http://localhost:${coordinatorPort}/api/coordinator-key`);
    assert.strictEqual(response.ok, true, 'Coordinator should be running');

    // Stop and restart coordinator
    await coordinator.stop();
    await setTimeout(1000);

    coordinator = new Coordinator({
      privateKeyPath: './keys/coordinator.priv',
      publicKeyPath: './keys/coordinator.pub',
      serverTimeout: 30000,
      maxServers: 100,
      udp: {
        port: 13347
      },
      https: {
        port: coordinatorPort,
        host: 'localhost'
      }
    });

    await coordinator.start();
    await setTimeout(1000);

    // Verify coordinator is back online
    response = await fetch(`http://localhost:${coordinatorPort}/api/coordinator-key`);
    assert.strictEqual(response.ok, true, 'Coordinator should be back online');
  });

  it('should maintain data integrity during restarts', async () => {
    // Verify coordinator state is consistent
    const response = await fetch(`http://localhost:${coordinatorPort}/api/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverPublicKeys: [] })
    });
    const servers = await response.json();

    // Should return valid array even after restart
    assert.ok(Array.isArray(servers), 'Server list should remain valid');
  });

  it('should handle rapid successive requests', async () => {
    // Send multiple requests in quick succession
    const requests = Array.from({ length: 20 }, () =>
      fetch(`http://localhost:${coordinatorPort}/api/coordinator-key`)
    );

    const results = await Promise.all(requests);
    const successCount = results.filter(r => r.ok).length;

    assert.strictEqual(successCount, 20, 'All rapid requests should succeed');
  });
});
