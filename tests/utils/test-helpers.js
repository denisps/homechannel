/**
 * Test Helper Utilities
 * 
 * Common utilities for starting/stopping real coordinator and server instances
 * for integration and e2e tests.
 */

import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '../..');

/**
 * Start a real coordinator instance for testing
 * @param {object} options - Configuration options
 * @returns {Promise<{process, port, httpsPort, cleanup}>}
 */
export async function startTestCoordinator(options = {}) {
  const port = options.port || 3478;
  const httpsPort = options.httpsPort || 8443;
  
  // Create temporary config
  const config = {
    udpPort: port,
    httpsPort: httpsPort,
    host: '0.0.0.0',
    sessionTimeout: 60000,
    rateLimit: { windowMs: 60000, max: 1000 }
  };
  
  const configPath = path.join(projectRoot, 'coordinator', `test-config-${Date.now()}.json`);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  
  const coordinatorPath = path.join(projectRoot, 'coordinator', 'index.js');
  const proc = spawn('node', [coordinatorPath], {
    env: { ...process.env, CONFIG_PATH: configPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  let output = '';
  proc.stdout.on('data', (data) => {
    output += data.toString();
  });
  proc.stderr.on('data', (data) => {
    output += data.toString();
  });
  
  // Wait for coordinator to start
  await sleep(2000);
  
  const cleanup = async () => {
    proc.kill('SIGTERM');
    await sleep(500);
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
    try {
      await fs.unlink(configPath);
    } catch (err) {
      // Ignore if already deleted
    }
  };
  
  return {
    process: proc,
    port,
    httpsPort,
    output: () => output,
    cleanup
  };
}

/**
 * Start a real server instance for testing
 * @param {object} options - Configuration options
 * @returns {Promise<{process, config, cleanup}>}
 */
export async function startTestServer(options = {}) {
  const coordinatorHost = options.coordinatorHost || 'localhost';
  const coordinatorPort = options.coordinatorPort || 3478;
  const expectedAnswer = options.expectedAnswer || 'test-password';
  
  // Create temporary config
  const config = {
    coordinatorHost,
    coordinatorPort,
    expectedAnswer,
    enabledServices: ['files'],
    files: {
      allowedDirectories: [options.testDir || '/tmp'],
      maxFileSize: 10485760
    }
  };
  
  const configPath = path.join(projectRoot, 'server', `test-config-${Date.now()}.json`);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  
  const serverPath = path.join(projectRoot, 'server', 'index.js');
  const proc = spawn('node', [serverPath], {
    env: { ...process.env, CONFIG_PATH: configPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  let output = '';
  proc.stdout.on('data', (data) => {
    output += data.toString();
  });
  proc.stderr.on('data', (data) => {
    output += data.toString();
  });
  
  // Wait for server to start and register
  await sleep(3000);
  
  const cleanup = async () => {
    proc.kill('SIGTERM');
    await sleep(500);
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
    try {
      await fs.unlink(configPath);
    } catch (err) {
      // Ignore if already deleted
    }
  };
  
  return {
    process: proc,
    config,
    output: () => output,
    cleanup
  };
}

/**
 * Wait for a condition to be true with timeout
 * @param {Function} condition - Function that returns boolean
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {number} intervalMs - Check interval in milliseconds
 * @returns {Promise<void>}
 */
export async function waitForCondition(condition, timeoutMs = 5000, intervalMs = 100) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/**
 * Create a temporary directory for testing
 * @returns {Promise<{path, cleanup}>}
 */
export async function createTempDir() {
  const tmpDir = path.join('/tmp', `homechannel-test-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  
  const cleanup = async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore errors
    }
  };
  
  return {
    path: tmpDir,
    cleanup
  };
}

/**
 * Graceful test cleanup handler
 * Ensures all resources are cleaned up even if test fails
 */
export class TestCleanupHandler {
  constructor() {
    this.cleanupFns = [];
  }
  
  add(cleanupFn) {
    this.cleanupFns.push(cleanupFn);
  }
  
  async cleanup() {
    for (const fn of this.cleanupFns.reverse()) {
      try {
        await fn();
      } catch (err) {
        console.error('Cleanup error:', err);
      }
    }
    this.cleanupFns = [];
  }
}
