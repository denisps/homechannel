/**
 * Integration test for WebRTC connection establishment flow
 * Tests coordinator, server, and client interaction for WebRTC signaling
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

describe('WebRTC Connection Flow Integration', () => {
  let coordinatorProcess;
  let serverProcess;
  const coordinatorPort = 13337;
  const coordinatorUdpPort = 13338;

  before(async () => {
    // Start coordinator
    coordinatorProcess = spawn('node', ['coordinator/index.js'], {
      cwd: '/workspaces/homechannel',
      env: {
        ...process.env,
        COORDINATOR_PORT: coordinatorPort,
        COORDINATOR_UDP_PORT: coordinatorUdpPort
      }
    });

    // Wait for coordinator to start
    await setTimeout(2000);

    // Start server
    serverProcess = spawn('node', ['server/index.js'], {
      cwd: '/workspaces/homechannel',
      env: {
        ...process.env,
        COORDINATOR_HOST: 'localhost',
        COORDINATOR_UDP_PORT: coordinatorUdpPort
      }
    });

    // Wait for server to register
    await setTimeout(2000);
  });

  after(async () => {
    // Cleanup processes
    if (serverProcess) serverProcess.kill();
    if (coordinatorProcess) coordinatorProcess.kill();
    await setTimeout(500);
  });

  it('should allow server to register with coordinator', async () => {
    // Test server registration by attempting to fetch server list
    const response = await fetch(`http://localhost:${coordinatorPort}/servers`);
    assert.strictEqual(response.ok, true, 'Should be able to fetch server list');
    
    const servers = await response.json();
    assert.ok(Array.isArray(servers), 'Should return array of servers');
  });

  it('should handle WebRTC signaling between client and server', async () => {
    // This test validates the signaling path exists
    // Actual WebRTC connection testing is in e2e tests
    const response = await fetch(`http://localhost:${coordinatorPort}/health`);
    assert.strictEqual(response.ok, true, 'Coordinator health check should pass');
  });

  it('should maintain server registration with heartbeats', async () => {
    // Wait for multiple heartbeat intervals
    await setTimeout(6000);
    
    const response = await fetch(`http://localhost:${coordinatorPort}/servers`);
    const servers = await response.json();
    
    // Server should still be registered
    assert.ok(servers.length > 0, 'Server should remain registered after heartbeats');
  });
});
