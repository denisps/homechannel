/**
 * System test for multiple concurrent client connections
 * Tests scalability and resource management
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

describe('Multiple Clients System Test', () => {
  let coordinatorProcess;
  let serverProcess;
  const coordinatorPort = 13343;
  const clientCount = 5;

  before(async () => {
    // Start coordinator
    coordinatorProcess = spawn('node', ['coordinator/index.js'], {
      cwd: '/workspaces/homechannel',
      env: {
        ...process.env,
        COORDINATOR_PORT: coordinatorPort
      }
    });

    await setTimeout(2000);

    // Start server
    serverProcess = spawn('node', ['server/index.js'], {
      cwd: '/workspaces/homechannel'
    });

    await setTimeout(2000);
  });

  after(async () => {
    if (serverProcess) serverProcess.kill();
    if (coordinatorProcess) coordinatorProcess.kill();
    await setTimeout(500);
  });

  it('should handle multiple concurrent client connections', async () => {
    // Simulate multiple clients requesting server list
    const requests = Array.from({ length: clientCount }, (_, i) =>
      fetch(`http://localhost:${coordinatorPort}/servers`)
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
        fetch(`http://localhost:${coordinatorPort}/health`)
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
        fetch(`http://localhost:${coordinatorPort}/servers`)
          .then(() => setTimeout(Math.random() * 1000))
      );
    }

    await Promise.all(promises);

    // System should remain stable
    const healthCheck = await fetch(`http://localhost:${coordinatorPort}/health`);
    assert.strictEqual(healthCheck.ok, true, 'System should remain healthy');
  });
});
