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
import http from 'http';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '../..');

/**
 * Make HTTP/HTTPS request to a server
 * 
 * WARNING: This utility is for testing only. The default rejectUnauthorized: false
 * disables TLS certificate validation to allow self-signed certificates in tests.
 * NEVER use this default in production code.
 * 
 * @param {Object} options - Request options
 * @param {string} options.method - HTTP method (GET, POST, etc.)
 * @param {string} options.hostname - Server hostname
 * @param {number} options.port - Server port
 * @param {string} options.path - Request path
 * @param {Object} options.body - Request body (will be JSON stringified)
 * @param {boolean} options.useTLS - Whether to use HTTPS (default: false)
 * @param {boolean} options.rejectUnauthorized - Reject invalid TLS certs (default: false FOR TESTING ONLY)
 * @returns {Promise<{statusCode, headers, body}>}
 */
export function makeHttpRequest(options) {
  return new Promise((resolve, reject) => {
    const protocol = options.useTLS ? https : http;
    
    const reqOptions = {
      hostname: options.hostname || 'localhost',
      port: options.port,
      path: options.path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      // WARNING: rejectUnauthorized: false is ONLY for testing with self-signed certs
      // Production code should ALWAYS validate certificates (use true or omit this option)
      rejectUnauthorized: options.rejectUnauthorized ?? false
    };
    
    const req = protocol.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = {
            statusCode: res.statusCode,
            headers: res.headers,
            body: data ? JSON.parse(data) : null
          };
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });
    
    req.on('error', reject);
    
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

/**
 * Create a request helper bound to a specific server
 * @param {number} port - Server port
 * @param {boolean} useTLS - Whether to use HTTPS
 * @returns {Function} - makeRequest(method, path, body)
 */
export function createRequestHelper(port, useTLS = false) {
  return function makeRequest(method, path, body = null) {
    return makeHttpRequest({
      method,
      hostname: 'localhost',
      port,
      path,
      body,
      useTLS
    });
  };
}

/**
 * Gracefully stop a UDPClient and cleanup
 * @param {Object} client - UDPClient instance
 */
export async function cleanupClient(client) {
  if (!client) return;
  
  try {
    await client.stop();
  } catch (err) {
    // If stop fails, try to close socket directly
    if (client.socket) {
      try {
        client.socket.close();
      } catch (socketErr) {
        // Ignore socket close errors
      }
    }
  }
}

/**
 * Create a ping counting wrapper for UDPServer
 * Tracks PING messages received from clients
 * @param {Object} udpServer - UDPServer instance
 * @returns {Object} - { pingCounts: Map, restore: Function }
 */
export function createPingCounter(udpServer) {
  const pingCountByClient = new Map();
  const originalHandleMessage = udpServer.handleMessage.bind(udpServer);
  
  // Wrap handleMessage to count pings
  udpServer.handleMessage = (msg, rinfo) => {
    // PING messages have type 0x06 at byte position 1
    if (msg.length >= 2 && msg[1] === 0x06) {
      const clientKey = `${rinfo.address}:${rinfo.port}`;
      pingCountByClient.set(clientKey, (pingCountByClient.get(clientKey) || 0) + 1);
    }
    return originalHandleMessage(msg, rinfo);
  };
  
  return {
    pingCounts: pingCountByClient,
    getTotalPings: () => {
      let total = 0;
      for (const count of pingCountByClient.values()) {
        total += count;
      }
      return total;
    },
    restore: () => {
      udpServer.handleMessage = originalHandleMessage;
    }
  };
}

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
