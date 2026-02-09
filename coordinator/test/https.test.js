import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import https from 'https';
import { HTTPSServer } from '../https.js';
import { ServerRegistry } from '../registry.js';
import { UDPServer } from '../../shared/protocol.js';
import { generateSigningKeyPair } from '../../shared/keys.js';
import { signData, verifySignature, generateChallenge, hashChallengeAnswer } from '../../shared/crypto.js';
import { generateSelfSignedCertificate, isOpenSSLAvailable } from '../../shared/tls.js';

function withConsoleErrorCapture(fn) {
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => {
    errors.push(args.join(' '));
  };

  const restore = () => {
    console.error = originalConsoleError;
  };

  return Promise.resolve()
    .then(fn)
    .then((result) => {
      restore();
      return { result, errors };
    })
    .catch((err) => {
      restore();
      throw err;
    });
}

/**
 * Helper to make HTTP/HTTPS requests
 */
async function makeRequest(method, path, body = null, port = 8443, useTLS = false) {
  return new Promise((resolve, reject) => {
    const protocol = useTLS ? https : http;
    const options = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      rejectUnauthorized: false // Accept self-signed certs for testing
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
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

describe('HTTPS Server', () => {
  let registry;
  let coordinatorKeys;
  let httpsServer;
  let mockUdpServer;
  let testPort = 8444; // Use different port for tests

  before(async () => {
    // Setup
    registry = new ServerRegistry();
    coordinatorKeys = generateSigningKeyPair();
    
    // Create mock UDP server with sendOfferToServer method
    mockUdpServer = {
      sendOfferToServer: async (ipPort, sessionId, payload) => {
        // Mock implementation
        return Promise.resolve();
      },
      on: (type, handler) => {
        // Mock implementation
      }
    };
    
    // Start in HTTP mode for basic tests (no TLS cert/key provided)
    httpsServer = new HTTPSServer(registry, coordinatorKeys, mockUdpServer, {
      port: testPort,
      host: 'localhost'
    });
    
    await httpsServer.start();
  });

  after(async () => {
    await httpsServer.stop();
    registry.destroy();
  });

  describe('GET /api/coordinator-key', () => {
    test('should return coordinator public key with signature', async () => {
      const response = await makeRequest('GET', '/api/coordinator-key', null, testPort);
      
      assert.strictEqual(response.status, 200);
      assert.ok(response.data.publicKey);
      assert.ok(response.data.signature);
      
      // Verify signature (response is base64, sign with wrapped PEM for verification)
      const data = { publicKey: response.data.publicKey };
      const isValid = verifySignature(data, response.data.signature, coordinatorKeys.publicKey);
      assert.ok(isValid, 'Signature should be valid');
    });
  });

  describe('POST /api/servers', () => {
    test('should return empty list for unknown servers', async () => {
      const response = await makeRequest('POST', '/api/servers', {
        serverPublicKeys: ['unknown-key-1', 'unknown-key-2']
      }, testPort);
      
      assert.strictEqual(response.status, 200);
      assert.ok(Array.isArray(response.data.servers));
      assert.strictEqual(response.data.servers.length, 0);
      assert.ok(response.data.signature);
    });

    test('should return known servers with their info', async () => {
      // Register a test server
      const challenge = generateChallenge();
      const password = 'test-password';
      const expectedAnswer = hashChallengeAnswer(challenge, password);
      const serverKey = 'test-server-key';
      
      registry.register(serverKey, '127.0.0.1:12345', challenge, expectedAnswer);
      
      const response = await makeRequest('POST', '/api/servers', {
        serverPublicKeys: [serverKey]
      }, testPort);
      
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.data.servers.length, 1);
      
      const server = response.data.servers[0];
      assert.strictEqual(server.publicKeyHash, serverKey);
      assert.ok(server.name);
      assert.strictEqual(server.online, true);
      assert.strictEqual(server.challenge, challenge);
      
      // Verify coordinator signature
      const dataToVerify = { servers: response.data.servers };
      const isValid = verifySignature(dataToVerify, response.data.signature, coordinatorKeys.publicKey);
      assert.ok(isValid, 'Coordinator signature should be valid');
    });

    test('should handle invalid request body', async () => {
      const response = await makeRequest('POST', '/api/servers', {
        serverPublicKeys: 'not-an-array'
      }, testPort);
      
      assert.strictEqual(response.status, 400);
      assert.ok(response.data.error);
    });
  });

  describe('POST /api/connect', () => {
    test('should initiate connection with valid challenge answer', async () => {
      // Register a test server
      const challenge = generateChallenge();
      const password = 'test-password';
      const expectedAnswer = hashChallengeAnswer(challenge, password);
      const serverKey = 'test-server-connect';
      
      registry.register(serverKey, '127.0.0.1:12346', challenge, expectedAnswer);
      
      const response = await makeRequest('POST', '/api/connect', {
        serverPublicKey: serverKey,
        challengeAnswer: expectedAnswer,
        payload: {
          sdp: { type: 'offer', sdp: 'test-sdp' },
          candidates: [{ candidate: 'test-candidate' }]
        },
        timestamp: Date.now()
      }, testPort);
      
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.data.success, true);
      assert.ok(response.data.sessionId);
      assert.ok(response.data.message);
      assert.ok(response.data.coordinatorSignature);
      
      // Verify coordinator signature
      const dataToVerify = {
        success: response.data.success,
        sessionId: response.data.sessionId,
        message: response.data.message
      };
      const isValid = verifySignature(dataToVerify, response.data.coordinatorSignature, coordinatorKeys.publicKey);
      assert.ok(isValid, 'Coordinator signature should be valid');
    });

    test('should reject with invalid challenge answer', async () => {
      const challenge = generateChallenge();
      const password = 'correct-password';
      const expectedAnswer = hashChallengeAnswer(challenge, password);
      const serverKey = 'test-server-invalid';
      
      registry.register(serverKey, '127.0.0.1:12347', challenge, expectedAnswer);
      
      const response = await makeRequest('POST', '/api/connect', {
        serverPublicKey: serverKey,
        challengeAnswer: 'wrong-answer',
        payload: {
          sdp: { type: 'offer', sdp: 'test-sdp' },
          candidates: []
        },
        timestamp: Date.now()
      }, testPort);
      
      assert.strictEqual(response.status, 403);
      assert.ok(response.data.error);
    });

    test('should reject with unknown server', async () => {
      const response = await makeRequest('POST', '/api/connect', {
        serverPublicKey: 'unknown-server',
        challengeAnswer: 'some-answer',
        payload: {
          sdp: { type: 'offer', sdp: 'test-sdp' },
          candidates: []
        },
        timestamp: Date.now()
      }, testPort);
      
      assert.strictEqual(response.status, 404);
      assert.ok(response.data.error);
    });

    test('should reject with missing fields', async () => {
      const response = await makeRequest('POST', '/api/connect', {
        serverPublicKey: 'test-server'
      }, testPort);
      
      assert.strictEqual(response.status, 400);
      assert.ok(response.data.error);
    });

    test('should reject with expired timestamp', async () => {
      const challenge = generateChallenge();
      const password = 'test-password';
      const expectedAnswer = hashChallengeAnswer(challenge, password);
      const serverKey = 'test-server-expired';
      
      registry.register(serverKey, '127.0.0.1:12348', challenge, expectedAnswer);
      
      const response = await makeRequest('POST', '/api/connect', {
        serverPublicKey: serverKey,
        challengeAnswer: expectedAnswer,
        payload: {
          sdp: { type: 'offer', sdp: 'test-sdp' },
          candidates: []
        },
        timestamp: Date.now() - 120000 // 2 minutes ago
      }, testPort);
      
      assert.strictEqual(response.status, 400);
      assert.ok(response.data.error);
    });
  });

  describe('POST /api/poll', () => {
    test('should return waiting status when no answer available', async () => {
      // First create a connection
      const challenge = generateChallenge();
      const password = 'test-password';
      const expectedAnswer = hashChallengeAnswer(challenge, password);
      const serverKey = 'test-server-poll-waiting';
      
      registry.register(serverKey, '127.0.0.1:12349', challenge, expectedAnswer);
      
      const connectResponse = await makeRequest('POST', '/api/connect', {
        serverPublicKey: serverKey,
        challengeAnswer: expectedAnswer,
        payload: {
          sdp: { type: 'offer', sdp: 'test-sdp' },
          candidates: []
        },
        timestamp: Date.now()
      }, testPort);
      
      const sessionId = connectResponse.data.sessionId;
      
      // Poll for answer
      const pollResponse = await makeRequest('POST', '/api/poll', {
        sessionId,
        lastUpdate: Date.now()
      }, testPort);
      
      assert.strictEqual(pollResponse.status, 200);
      assert.strictEqual(pollResponse.data.success, false);
      assert.strictEqual(pollResponse.data.waiting, true);
      assert.ok(pollResponse.data.coordinatorSignature);
      
      // Verify signature
      const dataToVerify = {
        success: pollResponse.data.success,
        waiting: pollResponse.data.waiting
      };
      const isValid = verifySignature(dataToVerify, pollResponse.data.coordinatorSignature, coordinatorKeys.publicKey);
      assert.ok(isValid, 'Coordinator signature should be valid');
    });

    test('should return answer when available', async () => {
      // First create a connection
      const challenge = generateChallenge();
      const password = 'test-password';
      const expectedAnswer = hashChallengeAnswer(challenge, password);
      const serverKey = 'test-server-poll-answer';
      
      registry.register(serverKey, '127.0.0.1:12350', challenge, expectedAnswer);
      
      const connectResponse = await makeRequest('POST', '/api/connect', {
        serverPublicKey: serverKey,
        challengeAnswer: expectedAnswer,
        payload: {
          sdp: { type: 'offer', sdp: 'test-sdp' },
          candidates: []
        },
        timestamp: Date.now()
      }, testPort);
      
      const sessionId = connectResponse.data.sessionId;
      
      // Simulate server answer
      const serverAnswer = {
        sdp: { type: 'answer', sdp: 'test-answer-sdp' },
        candidates: [{ candidate: 'test-answer-candidate' }]
      };
      const serverSignature = 'test-signature';
      
      httpsServer.storeServerAnswer(sessionId, serverAnswer, serverSignature, 'ed448');
      
      // Poll for answer
      const pollResponse = await makeRequest('POST', '/api/poll', {
        sessionId,
        lastUpdate: Date.now()
      }, testPort);
      
      assert.strictEqual(pollResponse.status, 200);
      assert.strictEqual(pollResponse.data.success, true);
      assert.deepStrictEqual(pollResponse.data.payload, serverAnswer);
      assert.strictEqual(pollResponse.data.serverSignature, serverSignature);
      assert.ok(pollResponse.data.coordinatorSignature);
      
      // Verify signature
      const dataToVerify = {
        success: pollResponse.data.success,
        payload: pollResponse.data.payload,
        serverSignature: pollResponse.data.serverSignature,
        serverSignatureAlgorithm: pollResponse.data.serverSignatureAlgorithm
      };
      const isValid = verifySignature(dataToVerify, pollResponse.data.coordinatorSignature, coordinatorKeys.publicKey);
      assert.ok(isValid, 'Coordinator signature should be valid');
    });

    test('should return 404 for unknown session', async () => {
      const response = await makeRequest('POST', '/api/poll', {
        sessionId: 'unknown-session-id',
        lastUpdate: Date.now()
      }, testPort);
      
      assert.strictEqual(response.status, 404);
      assert.ok(response.data.error);
    });

    test('should return 400 for missing sessionId', async () => {
      const response = await makeRequest('POST', '/api/poll', {
        lastUpdate: Date.now()
      }, testPort);
      
      assert.strictEqual(response.status, 400);
      assert.ok(response.data.error);
    });
  });

  describe('CORS headers', () => {
    test('should include CORS headers in responses', async () => {
      const response = await makeRequest('GET', '/api/coordinator-key', null, testPort);
      
      assert.ok(response.headers['access-control-allow-origin']);
      assert.ok(response.headers['access-control-allow-methods']);
      assert.ok(response.headers['access-control-allow-headers']);
    });

    test('should handle OPTIONS preflight', async () => {
      const response = await makeRequest('OPTIONS', '/api/servers', null, testPort);
      
      assert.strictEqual(response.status, 200);
      assert.ok(response.headers['access-control-allow-origin']);
    });
  });

  describe('Rate limiting', () => {
    test('should rate limit excessive requests', async () => {
      // Make many requests quickly
      const promises = [];
      for (let i = 0; i < 35; i++) {
        promises.push(makeRequest('GET', '/api/coordinator-key', null, testPort));
      }
      
      const responses = await Promise.all(promises);
      const rateLimited = responses.some(r => r.status === 429);
      
      assert.ok(rateLimited, 'Should rate limit after many requests');
    });
  });

  describe('Session cleanup', () => {
    test('should cleanup expired sessions', async (t) => {
      // Create HTTPS server with short timeout for testing
      const testRegistry = new ServerRegistry();
      const testHttpsServer = new HTTPSServer(testRegistry, coordinatorKeys, mockUdpServer, {
        port: 8445,
        host: 'localhost',
        sessionTimeout: 100 // 100ms timeout
      });
      
      await testHttpsServer.start();
      
      // Create a session
      const challenge = generateChallenge();
      const password = 'test-password';
      const expectedAnswer = hashChallengeAnswer(challenge, password);
      const serverKey = 'test-server-cleanup';
      
      testRegistry.register(serverKey, '127.0.0.1:12351', challenge, expectedAnswer);
      
      const connectResponse = await makeRequest('POST', '/api/connect', {
        serverPublicKey: serverKey,
        challengeAnswer: expectedAnswer,
        payload: {
          sdp: { type: 'offer', sdp: 'test-sdp' },
          candidates: []
        },
        timestamp: Date.now()
      }, 8445);
      
      const sessionId = connectResponse.data.sessionId;
      
      // Wait for session to expire
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Try to poll - should get 408
      const pollResponse = await makeRequest('POST', '/api/poll', {
        sessionId,
        lastUpdate: Date.now()
      }, 8445);
      
      assert.strictEqual(pollResponse.status, 408);
      assert.ok(pollResponse.data.error);
      
      await testHttpsServer.stop();
      testRegistry.destroy();
    });
  });

  describe('Error handling', () => {
    test('should return 404 for unknown routes', async (t) => {
      // Use a fresh server to avoid rate limiting from previous tests
      const testRegistry = new ServerRegistry();
      const testHttpsServer = new HTTPSServer(testRegistry, coordinatorKeys, mockUdpServer, {
        port: 8446,
        host: 'localhost'
      });
      
      await testHttpsServer.start();
      
      const response = await makeRequest('GET', '/api/unknown', null, 8446);
      
      assert.strictEqual(response.status, 404);
      assert.ok(response.data.error);
      
      await testHttpsServer.stop();
      testRegistry.destroy();
    });

    test('should handle malformed JSON', async (t) => {
      // Use a fresh server to avoid rate limiting from previous tests
      const testRegistry = new ServerRegistry();
      const testHttpsServer = new HTTPSServer(testRegistry, coordinatorKeys, mockUdpServer, {
        port: 8447,
        host: 'localhost'
      });
      
      await testHttpsServer.start();

      const { result: response, errors } = await withConsoleErrorCapture(() => {
        return new Promise((resolve, reject) => {
          const req = http.request({
            hostname: 'localhost',
            port: 8447,
            path: '/api/servers',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              resolve({
                status: res.statusCode,
                data
              });
            });
          });

          req.on('error', reject);
          req.write('invalid json{');
          req.end();
        });
      });

      let parsedResponse = null;
      let responseParseError = null;
      try {
        parsedResponse = response.data ? JSON.parse(response.data) : null;
      } catch (err) {
        responseParseError = err;
      }

      assert.strictEqual(response.status, 400);
      assert.strictEqual(responseParseError, null, 'Response JSON should be valid');
      assert.ok(errors.length > 0, 'Expected malformed JSON to be logged');
      assert.ok(
        errors.some((message) => message.includes('Invalid JSON')),
        'Expected Invalid JSON to be logged'
      );
      
      await testHttpsServer.stop();
      testRegistry.destroy();
    });
  });

  describe('TLS Mode', () => {
    test('should start in HTTPS mode with TLS certificates', async (t) => {
      // Skip if OpenSSL is not available
      if (!isOpenSSLAvailable()) {
        t.skip('OpenSSL not available for certificate generation');
        return;
      }

      const testRegistry = new ServerRegistry();
      
      // Generate self-signed certificate for testing
      const { cert, key } = generateSelfSignedCertificate({ commonName: 'localhost' });
      
      const testHttpsServer = new HTTPSServer(testRegistry, coordinatorKeys, mockUdpServer, {
        port: 8449,
        host: 'localhost',
        cert,
        key
      });
      
      await testHttpsServer.start();
      
      // Make HTTPS request
      const response = await makeRequest('GET', '/api/coordinator-key', null, 8449, true);
      
      assert.strictEqual(response.status, 200);
      assert.ok(response.data.publicKey);
      assert.ok(response.data.signature);
      
      await testHttpsServer.stop();
      testRegistry.destroy();
    });

    test('should accept cert and key directly without files', async (t) => {
      // Skip if OpenSSL is not available
      if (!isOpenSSLAvailable()) {
        t.skip('OpenSSL not available for certificate generation');
        return;
      }

      const testRegistry = new ServerRegistry();
      const { cert, key } = generateSelfSignedCertificate({ commonName: 'localhost' });
      
      const testHttpsServer = new HTTPSServer(testRegistry, coordinatorKeys, mockUdpServer, {
        port: 8450,
        host: 'localhost',
        cert,
        key
      });
      
      // Verify it detects TLS mode
      assert.strictEqual(testHttpsServer.useTLS, true, 'Should detect TLS mode when cert/key provided');
      
      await testHttpsServer.start();
      
      // Verify we can make HTTPS requests
      const response = await makeRequest('GET', '/api/coordinator-key', null, 8450, true);
      assert.strictEqual(response.status, 200);
      
      await testHttpsServer.stop();
      testRegistry.destroy();
    });

    test('should fall back to HTTP when no TLS credentials provided', async () => {
      const testRegistry = new ServerRegistry();
      
      const testHttpsServer = new HTTPSServer(testRegistry, coordinatorKeys, mockUdpServer, {
        port: 8451,
        host: 'localhost'
        // No cert or key provided
      });
      
      // Verify it detects non-TLS mode
      assert.strictEqual(testHttpsServer.useTLS, false, 'Should detect non-TLS mode when no cert/key');
      
      await testHttpsServer.start();
      
      // Verify we can make HTTP requests (not HTTPS)
      const response = await makeRequest('GET', '/api/coordinator-key', null, 8451, false);
      assert.strictEqual(response.status, 200);
      
      await testHttpsServer.stop();
      testRegistry.destroy();
    });
  });
});
