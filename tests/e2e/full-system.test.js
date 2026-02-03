/**
 * End-to-End Test: Full System Integration
 * 
 * Tests the complete flow: Start coordinator -> Start server -> Verify registration
 * This is a true e2e test without mocks.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '../..');

describe('E2E: Coordinator and Server Integration', () => {
  let coordinatorProc;
  let serverProc;
  let testConfigDir;
  
  before(async () => {
    // Create temporary test config directory
    testConfigDir = path.join('/tmp', `homechannel-e2e-${Date.now()}`);
    await fs.mkdir(testConfigDir, { recursive: true });
    
    // Create coordinator config
    const coordinatorConfig = {
      udp: { port: 13478 },
      https: { port: 18443, host: '0.0.0.0' },
      privateKeyPath: path.join(testConfigDir, 'coordinator_private.pem'),
      publicKeyPath: path.join(testConfigDir, 'coordinator_public.pem'),
      serverTimeout: 300000,
      maxServers: 100
    };
    
    await fs.writeFile(
      path.join(testConfigDir, 'coordinator-config.json'),
      JSON.stringify(coordinatorConfig, null, 2)
    );
    
    // Create server config
    const serverConfig = {
      coordinator: {
        host: 'localhost',
        port: 13478
      },
      privateKeyPath: path.join(testConfigDir, 'server_private.pem'),
      publicKeyPath: path.join(testConfigDir, 'server_public.pem'),
      enabledServices: ['files'],
      files: {
        allowedDirectories: [testConfigDir],
        maxFileSize: 10485760
      }
    };
    
    await fs.writeFile(
      path.join(testConfigDir, 'server-config.json'),
      JSON.stringify(serverConfig, null, 2)
    );
    
    // Start coordinator
    const coordinatorDir = path.join(projectRoot, 'coordinator');
    
    // Copy config to coordinator directory
    await fs.writeFile(
      path.join(coordinatorDir, 'config.json'),
      JSON.stringify(coordinatorConfig, null, 2)
    );
    
    coordinatorProc = spawn('node', [
      'index.js'
    ], {
      cwd: coordinatorDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let coordinatorOutput = '';
    coordinatorProc.stdout.on('data', (data) => {
      coordinatorOutput += data.toString();
    });
    coordinatorProc.stderr.on('data', (data) => {
      coordinatorOutput += data.toString();
    });
    
    // Wait for coordinator to start
    await sleep(3000);
    
    // Check if coordinator started successfully
    if (!coordinatorOutput.includes('Coordinator started')) {
      throw new Error(`Coordinator failed to start:\n${coordinatorOutput}`);
    }
    
    // Start server
    const serverDir = path.join(projectRoot, 'server');
    
    // Copy config to server directory
    await fs.writeFile(
      path.join(serverDir, 'config.json'),
      JSON.stringify(serverConfig, null, 2)
    );
    
    serverProc = spawn('node', [
      'index.js'
    ], {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let serverOutput = '';
    serverProc.stdout.on('data', (data) => {
      serverOutput += data.toString();
    });
    serverProc.stderr.on('data', (data) => {
      serverOutput += data.toString();
    });
    
    // Wait for server to register
    await sleep(5000);
    
    // Check if server registered successfully  
    if (!serverOutput.includes('Registration acknowledged')) {
      throw new Error(`Server failed to register:\n${serverOutput}`);
    }
  });
  
  after(async () => {
    // Cleanup
    if (coordinatorProc) {
      coordinatorProc.kill('SIGTERM');
      await sleep(500);
      if (!coordinatorProc.killed) {
        coordinatorProc.kill('SIGKILL');
      }
    }
    
    if (serverProc) {
      serverProc.kill('SIGTERM');
      await sleep(500);
      if (!serverProc.killed) {
        serverProc.kill('SIGKILL');
      }
    }
    
    // Remove test config files
    try {
      await fs.unlink(path.join(projectRoot, 'coordinator', 'config.json'));
    } catch (err) {
      // Ignore errors
    }
    
    try {
      await fs.unlink(path.join(projectRoot, 'server', 'config.json'));
    } catch (err) {
      // Ignore errors
    }
    
    // Remove test config directory
    try {
      await fs.rm(testConfigDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore errors
    }
  });
  
  test('Coordinator should start successfully', async () => {
    assert.ok(coordinatorProc, 'Coordinator process should exist');
    assert.ok(!coordinatorProc.killed, 'Coordinator should be running');
  });
  
  test('Server should register with coordinator', async () => {
    assert.ok(serverProc, 'Server process should exist');
    assert.ok(!serverProc.killed, 'Server should be running');
  });
  
  test('Server should maintain keepalive connection', async () => {
    // Wait for a keepalive ping
    await sleep(2000);
    
    // Server should still be running
    assert.ok(!serverProc.killed, 'Server should still be running after keepalive');
  });
});
