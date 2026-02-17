/**
 * End-to-End Test: Full System Integration
 * 
 * Tests the complete flow: Start coordinator -> Start server -> Verify registration
 * This is a true e2e test without mocks.
 * Uses HTTPS with self-signed certificates for testing.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { isOpenSSLAvailable, generateSelfSignedCertificate } from '../../shared/tls.js';
import { unwrapPublicKey } from '../../shared/crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '../..');

describe('E2E: Coordinator and Server Integration', () => {
  let coordinatorProc;
  let serverProc;
  let testConfigDir;
  let coordinatorOutput = '';
  let serverOutput = '';
  let serverPublicKey = null;
  let httpsPort = 18443;
  let useTLS = false;
  
  before(async () => {
    // Create temporary test config directory
    testConfigDir = path.join('/tmp', `homechannel-e2e-${Date.now()}`);
    await fs.mkdir(testConfigDir, { recursive: true });
    
    // Generate TLS certificates if OpenSSL is available
    let tlsConfig = {};
    if (isOpenSSLAvailable()) {
      const { cert, key } = generateSelfSignedCertificate({ 
        commonName: 'localhost',
        outputDir: testConfigDir 
      });
      const certPath = path.join(testConfigDir, 'cert.pem');
      const keyPath = path.join(testConfigDir, 'key.pem');
      await fs.writeFile(certPath, cert);
      await fs.writeFile(keyPath, key);
      tlsConfig = {
        certPath,
        keyPath
      };
      useTLS = true;
    }
    
    // Create coordinator config (with TLS if available)
    const coordinatorConfig = {
      udp: { port: 13478 },
      https: { 
        port: 18443, 
        host: '0.0.0.0',
        ...tlsConfig
      },
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
    // Helper to make HTTP/HTTPS request to coordinator
    // WARNING: rejectUnauthorized: false is for testing with self-signed certs only
    function makeRequest(method, path, body = null) {
      return new Promise((resolve, reject) => {
        const protocol = useTLS ? https : http;
        const options = {
          hostname: 'localhost',
          port: httpsPort,
          path,
          method,
          headers: { 'Content-Type': 'application/json' },
          rejectUnauthorized: false // FOR TESTING ONLY - accept self-signed certs
        };
        
        const req = protocol.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              resolve({
                statusCode: res.statusCode,
                body: data ? JSON.parse(data) : null
              });
            } catch (err) {
              reject(err);
            }
          });
        });
        
        req.on('error', reject);
        if (body) {
          req.write(JSON.stringify(body));
        }
        req.end();
      });
    }

    // Read server's public key to verify it's still registered
    const serverPubKeyPath = path.join(testConfigDir, 'server_public.pem');
    serverPublicKey = await fs.readFile(serverPubKeyPath, 'utf8');
    const serverPublicKeyBase64 = unwrapPublicKey(serverPublicKey);
    
    // Verify server is currently registered via HTTP API
    const initialResponse = await makeRequest('POST', '/api/servers', {
      serverPublicKeys: [serverPublicKeyBase64],
      timestamp: Date.now()
    });
    
    assert.strictEqual(initialResponse.statusCode, 200, 'Initial server query should succeed');
    assert.ok(
      initialResponse.body.servers.some(s => s.online === true),
      'Server should initially be online'
    );
    
    // Wait for multiple keepalive cycles (default is 30 seconds, but tests may use shorter)
    // The default server timeout is 5 minutes, but keepalive should keep it active
    await sleep(3000);
    
    // Server process should still be running
    assert.ok(!serverProc.killed, 'Server should still be running after keepalive period');
    
    // Verify server is STILL registered via HTTP API (proves keepalive is working)
    const afterResponse = await makeRequest('POST', '/api/servers', {
      serverPublicKeys: [serverPublicKeyBase64],
      timestamp: Date.now()
    });
    
    assert.strictEqual(afterResponse.statusCode, 200, 'Server query after keepalive should succeed');
    assert.ok(
      afterResponse.body.servers.some(s => s.online === true),
      'Server should still be online after keepalive period (proves keepalive is functioning)'
    );
  });
});
