/**
 * System test for load testing and performance validation
 * Tests system behavior under sustained high load
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { Coordinator } from '../../coordinator/index.js';
import { setTimeout } from 'node:timers/promises';

describe('Load Testing System Test', () => {
  let coordinator;
  const coordinatorPort = 13345;

  before(async () => {
    // Start coordinator programmatically
    coordinator = new Coordinator({
      privateKeyPath: './keys/coordinator.priv',
      publicKeyPath: './keys/coordinator.pub',
      serverTimeout: 30000,
      maxServers: 100,
      udp: {
        port: 13346
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

  it('should handle burst traffic', async () => {
    const burstSize = 50;
    const startTime = Date.now();

    // Send burst of requests
    const requests = Array.from({ length: burstSize }, () =>
      fetch(`http://localhost:${coordinatorPort}/api/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverPublicKeys: [] })
      })
        .then(res => res.json())
    );

    const results = await Promise.all(requests);
    const duration = Date.now() - startTime;

    // All requests should succeed
    const successCount = results.filter(r => Array.isArray(r)).length;
    assert.strictEqual(
      successCount,
      burstSize,
      `All ${burstSize} burst requests should succeed`
    );

    // Should handle burst in reasonable time (< 5 seconds)
    assert.ok(
      duration < 5000,
      `Burst should complete in < 5s, took ${duration}ms`
    );
  });

  it('should maintain consistent response times under load', async () => {
    const iterations = 20;
    const responseTimes = [];

    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      await fetch(`http://localhost:${coordinatorPort}/api/coordinator-key`);
      responseTimes.push(Date.now() - start);
      await setTimeout(100);
    }

    // Calculate statistics
    const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    const max = Math.max(...responseTimes);
    const min = Math.min(...responseTimes);
    const variance = max - min;

    assert.ok(avg < 50, `Average response time should be < 50ms, got ${avg.toFixed(2)}ms`);
    assert.ok(variance < 200, `Response time variance should be < 200ms, got ${variance}ms`);
  });

  it('should not leak memory under sustained load', async () => {
    const iterations = 100;
    const initialMemory = process.memoryUsage().heapUsed;

    // Generate sustained load
    for (let i = 0; i < iterations; i++) {
      await fetch(`http://localhost:${coordinatorPort}/api/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverPublicKeys: [] })
      });
      
      // Small delay to prevent overwhelming
      if (i % 10 === 0) {
        await setTimeout(10);
      }
    }

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    await setTimeout(1000);

    const finalMemory = process.memoryUsage().heapUsed;
    const memoryIncrease = finalMemory - initialMemory;
    const memoryIncreaseMB = memoryIncrease / 1024 / 1024;

    // Memory increase should be reasonable (< 50MB)
    assert.ok(
      memoryIncreaseMB < 50,
      `Memory increase should be < 50MB, got ${memoryIncreaseMB.toFixed(2)}MB`
    );
  });

  it('should handle concurrent long-polling connections', async () => {
    const connections = 10;
    const timeout = 2000;

    const requests = Array.from({ length: connections }, () =>
      fetch(`http://localhost:${coordinatorPort}/api/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverPublicKeys: [] }),
        signal: AbortSignal.timeout(timeout)
      })
        .then(res => res.json())
        .catch(err => {
          if (err.name === 'TimeoutError') return { timeout: true };
          throw err;
        })
    );

    const results = await Promise.all(requests);

    // At least some should complete successfully
    const successCount = results.filter(r => Array.isArray(r)).length;
    assert.ok(
      successCount > 0,
      'Should handle some concurrent connections successfully'
    );
  });
});
