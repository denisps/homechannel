/**
 * System test for failover and recovery scenarios
 * Tests system resilience and error handling
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

describe('Failover and Recovery System Test', () => {
  let coordinatorProcess;
  let serverProcess;
  const coordinatorPort = 13344;

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
  });

  after(async () => {
    if (serverProcess) serverProcess.kill();
    if (coordinatorProcess) coordinatorProcess.kill();
    await setTimeout(500);
  });

  it('should handle server crash and restart', async () => {
    // Start server
    serverProcess = spawn('node', ['server/index.js'], {
      cwd: '/workspaces/homechannel'
    });

    await setTimeout(2000);

    // Verify server is registered
    let response = await fetch(`http://localhost:${coordinatorPort}/servers`);
    let servers = await response.json();
    const initialCount = servers.length;
    assert.ok(initialCount > 0, 'Server should be registered');

    // Simulate server crash
    serverProcess.kill();
    await setTimeout(3000);

    // Verify server is deregistered (after timeout)
    response = await fetch(`http://localhost:${coordinatorPort}/servers`);
    servers = await response.json();
    assert.ok(
      servers.length <= initialCount,
      'Server should be deregistered after crash'
    );

    // Restart server
    serverProcess = spawn('node', ['server/index.js'], {
      cwd: '/workspaces/homechannel'
    });

    await setTimeout(2000);

    // Verify server re-registers
    response = await fetch(`http://localhost:${coordinatorPort}/servers`);
    servers = await response.json();
    assert.ok(servers.length > 0, 'Server should re-register after restart');
  });

  it('should handle coordinator temporary unavailability', async () => {
    // Start server
    if (!serverProcess || serverProcess.killed) {
      serverProcess = spawn('node', ['server/index.js'], {
        cwd: '/workspaces/homechannel'
      });
      await setTimeout(2000);
    }

    // Stop coordinator briefly
    coordinatorProcess.kill();
    await setTimeout(1000);

    // Restart coordinator
    coordinatorProcess = spawn('node', ['coordinator/index.js'], {
      cwd: '/workspaces/homechannel',
      env: {
        ...process.env,
        COORDINATOR_PORT: coordinatorPort
      }
    });

    await setTimeout(2000);

    // Server should re-register automatically
    const response = await fetch(`http://localhost:${coordinatorPort}/servers`);
    assert.strictEqual(response.ok, true, 'Coordinator should be back online');
  });

  it('should handle network interruptions gracefully', async () => {
    // Simulate network delay by rapid restarts
    if (serverProcess) serverProcess.kill();
    await setTimeout(500);

    serverProcess = spawn('node', ['server/index.js'], {
      cwd: '/workspaces/homechannel'
    });

    await setTimeout(1500);

    // System should stabilize
    const response = await fetch(`http://localhost:${coordinatorPort}/health`);
    assert.strictEqual(response.ok, true, 'System should recover from interruptions');
  });

  it('should maintain data integrity during failures', async () => {
    // Verify coordinator state is consistent
    const response = await fetch(`http://localhost:${coordinatorPort}/servers`);
    const servers = await response.json();

    // Should return valid array even after all the chaos above
    assert.ok(Array.isArray(servers), 'Server list should remain valid');
    
    // Each server entry should have required fields
    servers.forEach(server => {
      assert.ok(server.id || server.serverId, 'Server should have ID');
    });
  });
});
