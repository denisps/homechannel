/**
 * System test for multiple concurrent client connections
 * Tests scalability and resource management
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Coordinator } from '../../coordinator/index.js';
import { setTimeout } from 'node:timers/promises';

describe('Multiple Clients System Test', () => {
  let coordinator;
  const coordinatorPort = 13343;
  const clientCount = 5;

  before(async () => {
    // Start coordinator programmatically
    coordinator = new Coordinator({
      privateKeyPath: './keys/coordinator.priv',
      publicKeyPath: './keys/coordinator.pub',
      serverTimeout: 30000,
      maxServers: 100,
      udp: {
        port: 13344
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

  it('should handle multiple concurrent client connections', async () => {
    // Simulate multiple clients requesting server list
    const requests = Array.from({ length: clientCount }, (_, i) =>
      fetch(`http://localhost:${coordinatorPort}/api/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverPublicKeys: [] })
      })
        .then(res => res.json())
        .catch(err => ({ error: err.message, clientId: i }))
    );

    const results = await Promise.all(requests);

    // All requests should succeed
    const successCount = results.filter(r => Array.isArray(r)).length;
    assert.ok(
      successCount === clientCount,
      `All ${clientCount} clients should receive server list, got ${successCount}`
    );
  });

  it('should maintain performance under concurrent load', async () => {
    const iterations = 10;
    const startTime = Date.now();

    // Simulate sustained load
    for (let i = 0; i < iterations; i++) {
      const requests = Array.from({ length: clientCount }, () =>
        fetch(`http://localhost:${coordinatorPort}/api/coordinator-key`)
      );
      await Promise.all(requests);
    }

    const duration = Date.now() - startTime;
    const avgResponseTime = duration / (iterations * clientCount);

    assert.ok(
      avgResponseTime < 100,
      `Average response time should be < 100ms, got ${avgResponseTime.toFixed(2)}ms`
    );
  });

  it('should handle client disconnections gracefully', async () => {
    // Simulate clients connecting and disconnecting
    const promises = [];
    
    for (let i = 0; i < clientCount; i++) {
      promises.push(
        fetch(`http://localhost:${coordinatorPort}/api/servers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverPublicKeys: [] })
        })
          .then(() => setTimeout(Math.random() * 1000))
      );
    }

    await Promise.all(promises);

    // System should remain stable
    const healthCheck = await fetch(`http://localhost:${coordinatorPort}/api/coordinator-key`);
    assert.strictEqual(healthCheck.ok, true, 'System should remain healthy');
  });
});
