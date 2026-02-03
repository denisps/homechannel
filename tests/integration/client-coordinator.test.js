/**
 * Integration Test: Client-Coordinator HTTPS Communication
 * 
 * Tests real HTTPS endpoints with actual coordinator instance.
 * Replaces mock implementations with real components.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import https from 'https';
import { TestCleanupHandler } from '../utils/test-helpers.js';
import { HTTPSServer } from '../../coordinator/https.js';
import { ServerRegistry } from '../../coordinator/registry.js';
import { UDPServer } from '../../shared/protocol.js';
import { generateECDSAKeyPair } from '../../shared/keys.js';
import { generateChallenge, hashChallengeAnswer, signData } from '../../shared/crypto.js';

describe('Client-Coordinator HTTPS Integration', () => {
  let cleanup;
  let httpsServer;
  let httpsPort;
  let registry;
  let coordinatorKeys;
  let udpServer;

  before(async () => {
    cleanup = new TestCleanupHandler();
    
    // Create real registry
    registry = new ServerRegistry();
    coordinatorKeys = generateECDSAKeyPair();
    
    // Create a mock UDP server for the HTTPS server
    udpServer = {
      sendOfferToServer: async () => {
        // Mock implementation - doesn't actually send
        return true;
      }
    };
    
    // Start real HTTPS server
    const httpsServerInstance = new HTTPSServer(
      registry,
      coordinatorKeys,
      udpServer,
      {
        port: 0, // Random port
        sessionTimeout: 60000
      }
    );
    
    await httpsServerInstance.start();
    httpsServer = httpsServerInstance.server;
    httpsPort = httpsServer.address().port;
    
    cleanup.add(async () => {
      if (httpsServer) {
        await new Promise((resolve) => {
          httpsServer.close(resolve);
        });
      }
    });
  });

  after(async () => {
    await cleanup.cleanup();
  });

  /**
   * Helper to make HTTPS request
   */
  function makeRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: httpsPort,
        path,
        method,
        rejectUnauthorized: false, // Accept self-signed cert
        headers: {
          'Content-Type': 'application/json'
        }
      };
      
      const req = https.request(options, (res) => {
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
      
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  test('GET /api/coordinator-key returns valid key', async () => {
    const response = await makeRequest('GET', '/api/coordinator-key');
    
    assert.strictEqual(response.statusCode, 200);
    assert.ok(response.body.publicKey, 'Should have publicKey');
    assert.ok(response.body.signature, 'Should have signature');
    assert.ok(response.body.timestamp, 'Should have timestamp');
    assert.ok(response.body.publicKey.includes('BEGIN PUBLIC KEY'), 'Should be PEM format');
  });

  test('POST /api/servers lists registered servers', async () => {
    // Register a test server
    const serverKeys = generateECDSAKeyPair();
    const challenge = generateChallenge();
    const serverKey = '192.168.1.100:12345';
    
    registry.registerServer(serverKey, serverKeys.publicKey, challenge);
    
    const response = await makeRequest('POST', '/api/servers', {
      publicKeys: [serverKeys.publicKey],
      timestamp: Date.now()
    });
    
    assert.strictEqual(response.statusCode, 200);
    assert.ok(Array.isArray(response.body.servers), 'Should have servers array');
    assert.ok(response.body.signature, 'Should have signature');
    
    const server = response.body.servers.find(s => s.publicKey === serverKeys.publicKey);
    assert.ok(server, 'Should find registered server');
    assert.strictEqual(server.status, 'online');
    assert.strictEqual(server.challenge, challenge);
  });

  test('POST /api/connect initiates connection', async () => {
    // Register a test server
    const serverKeys = generateECDSAKeyPair();
    const challenge = generateChallenge();
    const expectedAnswer = 'test-password';
    const serverKey = '192.168.1.100:12346';
    
    registry.registerServer(serverKey, serverKeys.publicKey, challenge);
    
    // Create valid challenge answer
    const challengeAnswer = hashChallengeAnswer(challenge, expectedAnswer);
    
    const response = await makeRequest('POST', '/api/connect', {
      serverPublicKey: serverKeys.publicKey,
      challengeAnswer,
      offer: {
        type: 'offer',
        sdp: 'v=0\r\no=- 1234 1234 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'
      },
      timestamp: Date.now()
    });
    
    assert.strictEqual(response.statusCode, 200);
    assert.ok(response.body.sessionId, 'Should have sessionId');
    assert.ok(response.body.signature, 'Should have signature');
    assert.strictEqual(response.body.status, 'waiting');
  });

  test('POST /api/connect rejects invalid challenge', async () => {
    const serverKeys = generateECDSAKeyPair();
    const challenge = generateChallenge();
    const serverKey = '192.168.1.100:12347';
    
    registry.registerServer(serverKey, serverKeys.publicKey, challenge);
    
    // Wrong challenge answer
    const wrongAnswer = hashChallengeAnswer(challenge, 'wrong-password');
    
    const response = await makeRequest('POST', '/api/connect', {
      serverPublicKey: serverKeys.publicKey,
      challengeAnswer: wrongAnswer,
      offer: {
        type: 'offer',
        sdp: 'v=0\r\no=- 1234 1234 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'
      },
      timestamp: Date.now()
    });
    
    assert.strictEqual(response.statusCode, 403);
    assert.ok(response.body.error.includes('Invalid challenge'), 'Should indicate invalid challenge');
  });

  test('POST /api/poll returns session status', async () => {
    // Register server and create session
    const serverKeys = generateECDSAKeyPair();
    const challenge = generateChallenge();
    const expectedAnswer = 'test-password';
    const serverKey = '192.168.1.100:12348';
    
    registry.registerServer(serverKey, serverKeys.publicKey, challenge);
    
    const challengeAnswer = hashChallengeAnswer(challenge, expectedAnswer);
    
    // Create connection
    const connectResponse = await makeRequest('POST', '/api/connect', {
      serverPublicKey: serverKeys.publicKey,
      challengeAnswer,
      offer: {
        type: 'offer',
        sdp: 'v=0\r\no=- 1234 1234 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'
      },
      timestamp: Date.now()
    });
    
    const sessionId = connectResponse.body.sessionId;
    
    // Poll for answer
    const pollResponse = await makeRequest('POST', '/api/poll', {
      sessionId,
      timestamp: Date.now()
    });
    
    assert.strictEqual(pollResponse.statusCode, 200);
    assert.ok(['waiting', 'answered'].includes(pollResponse.body.status), 'Should have valid status');
    assert.ok(pollResponse.body.signature, 'Should have signature');
  });

  test('CORS headers are present', async () => {
    const response = await makeRequest('GET', '/api/coordinator-key');
    
    assert.ok(response.headers['access-control-allow-origin'], 'Should have CORS origin header');
    assert.ok(response.headers['access-control-allow-methods'], 'Should have CORS methods header');
  });

  test('Rate limiting prevents excessive requests', async () => {
    // Make many requests quickly
    const requests = [];
    for (let i = 0; i < 100; i++) {
      requests.push(
        makeRequest('GET', '/api/coordinator-key').catch(err => ({ error: err }))
      );
    }
    
    const responses = await Promise.all(requests);
    
    // Some should be rate limited (429)
    const rateLimited = responses.filter(r => r.statusCode === 429);
    
    // With default rate limit of 30/min, after 30 requests we should see 429s
    // This test is probabilistic but should work most of the time
    assert.ok(
      rateLimited.length > 0 || responses.length <= 30,
      'Should have some rate-limited responses'
    );
  });
});
