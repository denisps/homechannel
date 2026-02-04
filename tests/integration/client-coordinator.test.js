/**
 * Integration Test: Client-Coordinator HTTPS Communication
 * 
 * Tests real HTTP/HTTPS endpoints with actual coordinator instance.
 * Tests both HTTP (fallback for testing) and HTTPS (production) modes.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import https from 'https';
import { TestCleanupHandler, createRequestHelper } from '../utils/test-helpers.js';
import { HTTPSServer } from '../../coordinator/https.js';
import { ServerRegistry } from '../../coordinator/registry.js';
import { UDPServer } from '../../shared/protocol.js';
import { generateECDSAKeyPair } from '../../shared/keys.js';
import { generateChallenge, hashChallengeAnswer, signData, unwrapPublicKey } from '../../shared/crypto.js';
import { generateSelfSignedCertificate, isOpenSSLAvailable } from '../../shared/tls.js';

describe('Client-Coordinator HTTPS Integration', () => {
  let cleanup;
  let httpsServerInstance;
  let httpsPort;
  let registry;
  let coordinatorKeys;
  let udpServer;
  let makeRequest;
  let useTLS = false;

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
    
    // Try to use HTTPS with TLS if OpenSSL is available
    let serverOptions = {
      port: 0, // Random port
      sessionTimeout: 60000
    };
    
    if (isOpenSSLAvailable()) {
      const { cert, key } = generateSelfSignedCertificate({ commonName: 'localhost' });
      serverOptions.cert = cert;
      serverOptions.key = key;
      useTLS = true;
    }
    
    // Start real HTTPS server
    httpsServerInstance = new HTTPSServer(
      registry,
      coordinatorKeys,
      udpServer,
      serverOptions
    );
    
    await httpsServerInstance.start();
    httpsPort = httpsServerInstance.server.address().port;
    
    // Create request helper for this test suite
    makeRequest = createRequestHelper(httpsPort, useTLS);
    
    cleanup.add(async () => {
      if (httpsServerInstance) {
        await httpsServerInstance.stop();
      }
    });
  });

  after(async () => {
    await cleanup.cleanup();
  });

  test('GET /api/coordinator-key returns valid key', async () => {
    const response = await makeRequest('GET', '/api/coordinator-key');
    
    assert.strictEqual(response.statusCode, 200);
    assert.ok(response.body.publicKey, 'Should have publicKey');
    assert.ok(response.body.signature, 'Should have signature');
    assert.ok(!response.body.publicKey.includes('BEGIN PUBLIC KEY'), 'Should be base64 format (unwrapped)');
    assert.ok(response.body.publicKey.length > 50, 'Should have substantial base64 content');
  });

  test('POST /api/servers lists registered servers', async () => {
    // Register a test server using correct API: register(serverPublicKey, ipPort, challenge, expectedAnswer)
    const serverKeys = generateECDSAKeyPair();
    const challenge = generateChallenge();
    const expectedAnswer = hashChallengeAnswer(challenge, 'test-password');
    const serverIpPort = '192.168.1.100:12345';
    
    // Registry stores base64 keys (unwrapped)
    const serverKeyBase64 = unwrapPublicKey(serverKeys.publicKey);
    registry.register(serverKeyBase64, serverIpPort, challenge, expectedAnswer);
    
    const response = await makeRequest('POST', '/api/servers', {
      serverPublicKeys: [serverKeys.publicKey], // Send PEM (will be unwrapped by server)
      timestamp: Date.now()
    });
    
    assert.strictEqual(response.statusCode, 200);
    assert.ok(Array.isArray(response.body.servers), 'Should have servers array');
    assert.ok(response.body.signature, 'Should have signature');
    
    const server = response.body.servers.find(s => s.publicKeyHash === serverKeyBase64);
    assert.ok(server, 'Should find registered server');
    assert.strictEqual(server.online, true, 'Server should be online');
    assert.strictEqual(server.challenge, challenge);
  });

  test('POST /api/connect initiates connection', async () => {
    // Register a test server using correct API: register(serverPublicKey, ipPort, challenge, expectedAnswer)
    const serverKeys = generateECDSAKeyPair();
    const challenge = generateChallenge();
    const password = 'test-password';
    const expectedAnswer = hashChallengeAnswer(challenge, password);
    const serverIpPort = '192.168.1.100:12346';
    
    // Registry stores base64 keys (unwrapped)
    const serverKeyBase64 = unwrapPublicKey(serverKeys.publicKey);
    registry.register(serverKeyBase64, serverIpPort, challenge, expectedAnswer);
    
    // Use the same expectedAnswer as the challenge answer (hashed password)
    const response = await makeRequest('POST', '/api/connect', {
      serverPublicKey: serverKeys.publicKey,
      challengeAnswer: expectedAnswer,
      payload: {
        sdp: 'v=0\r\no=- 1234 1234 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
        candidates: []
      },
      timestamp: Date.now()
    });
    
    assert.strictEqual(response.statusCode, 200);
    assert.ok(response.body.sessionId, 'Should have sessionId');
    assert.ok(response.body.coordinatorSignature, 'Should have coordinatorSignature');
    assert.strictEqual(response.body.success, true);
  });

  test('POST /api/connect rejects invalid challenge', async () => {
    const serverKeys = generateECDSAKeyPair();
    const challenge = generateChallenge();
    const password = 'test-password';
    const expectedAnswer = hashChallengeAnswer(challenge, password);
    const serverIpPort = '192.168.1.100:12347';
    
    // Registry stores base64 keys (unwrapped)
    const serverKeyBase64 = unwrapPublicKey(serverKeys.publicKey);
    registry.register(serverKeyBase64, serverIpPort, challenge, expectedAnswer);
    
    // Wrong challenge answer
    const wrongAnswer = hashChallengeAnswer(challenge, 'wrong-password');
    
    const response = await makeRequest('POST', '/api/connect', {
      serverPublicKey: serverKeys.publicKey,
      challengeAnswer: wrongAnswer,
      payload: {
        sdp: 'v=0\r\no=- 1234 1234 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
        candidates: []
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
    const password = 'test-password';
    const expectedAnswer = hashChallengeAnswer(challenge, password);
    const serverIpPort = '192.168.1.100:12348';
    
    // Registry stores base64 keys (unwrapped)
    const serverKeyBase64 = unwrapPublicKey(serverKeys.publicKey);
    registry.register(serverKeyBase64, serverIpPort, challenge, expectedAnswer);
    
    // Create connection
    const connectResponse = await makeRequest('POST', '/api/connect', {
      serverPublicKey: serverKeys.publicKey,
      challengeAnswer: expectedAnswer,
      payload: {
        sdp: 'v=0\r\no=- 1234 1234 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
        candidates: []
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
    assert.ok(pollResponse.body.coordinatorSignature, 'Should have coordinatorSignature');
    // Status should be waiting since server hasn't responded yet
    assert.strictEqual(pollResponse.body.waiting, true, 'Should be waiting for server response');
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
