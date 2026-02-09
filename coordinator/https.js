import http from 'http';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import { signData, hashChallengeAnswer, unwrapPublicKey } from '../shared/crypto.js';

/**
 * HTTPS server for client-coordinator communication
 * Provides REST API for WebRTC signaling
 * 
 * Supports both HTTPS (production) and HTTP (testing) modes.
 * HTTPS is required for production as Web Crypto API only works on secure origins.
 */
export class HTTPSServer {
  constructor(registry, coordinatorKeys, udpServer, options = {}) {
    this.registry = registry;
    this.coordinatorKeys = coordinatorKeys;
    this.udpServer = udpServer;
    this.options = options;
    this.signatureAlgorithm = options.signatureAlgorithm || coordinatorKeys.signatureAlgorithm || 'ed448';
    
    this.server = null;
    this.sessions = new Map(); // sessionId -> {clientOffer, timestamp, answer}
    this.sessionCleanupInterval = null;
    this.pendingResponses = new Map(); // sessionId -> {resolve, reject, timeout}
    
    // Rate limiting
    this.rateLimitMap = new Map(); // IP -> {count, resetTime}
    this.maxRequestsPerMinute = options.maxRequestsPerMinute || 30;
    
    // Session timeout (60 seconds)
    this.sessionTimeout = options.sessionTimeout || 60000;
    
    // TLS mode detection: use HTTPS if cert and key are provided
    this.useTLS = !!(options.certPath && options.keyPath) || !!(options.cert && options.key);
  }

  /**
   * Load TLS certificates from files
   */
  loadTLSCertificates() {
    const certPath = this.options.certPath;
    const keyPath = this.options.keyPath;
    
    if (!fs.existsSync(certPath)) {
      throw new Error(`TLS certificate not found: ${certPath}`);
    }
    if (!fs.existsSync(keyPath)) {
      throw new Error(`TLS private key not found: ${keyPath}`);
    }
    
    return {
      cert: fs.readFileSync(certPath, 'utf8'),
      key: fs.readFileSync(keyPath, 'utf8')
    };
  }

  // Note: Self-signed certificate generation is handled by shared/tls.js
  // Use generateSelfSignedCertificate() from that module for testing

  /**
   * Start HTTPS server
   */
  async start() {
    return new Promise((resolve, reject) => {
      const requestHandler = (req, res) => {
        this.handleRequest(req, res).catch(err => {
          console.error('Request handler error:', err);
          if (!res.headersSent) {
            this.sendError(res, 500, 'Internal server error');
          }
        });
      };

      if (this.useTLS) {
        // HTTPS mode with TLS
        let tlsOptions;
        
        if (this.options.cert && this.options.key) {
          // Certificates provided directly (e.g., for testing)
          tlsOptions = {
            cert: this.options.cert,
            key: this.options.key
          };
        } else {
          // Load certificates from files
          tlsOptions = this.loadTLSCertificates();
        }
        
        this.server = https.createServer(tlsOptions, requestHandler);
        
        this.server.listen(this.options.port || 8443, this.options.host || '0.0.0.0', () => {
          console.log(`HTTPS server (TLS) listening on ${this.options.host || '0.0.0.0'}:${this.options.port || 8443}`);
          
          // Start session cleanup
          this.sessionCleanupInterval = setInterval(() => {
            this.cleanupSessions();
          }, 30000).unref();
          
          resolve();
        });
      } else {
        // HTTP mode (for testing only - not secure for production)
        console.warn('Starting HTTP server (not HTTPS) - use only for testing!');
        
        this.server = http.createServer(requestHandler);

        this.server.listen(this.options.port || 8443, this.options.host || '0.0.0.0', () => {
          console.log(`HTTP server listening on ${this.options.host || '0.0.0.0'}:${this.options.port || 8443}`);
          
          // Start session cleanup
          this.sessionCleanupInterval = setInterval(() => {
            this.cleanupSessions();
          }, 30000).unref();
          
          resolve();
        });
      }

      this.server.on('error', reject);
    });
  }

  /**
   * Stop HTTPS server
   */
  async stop() {
    return new Promise((resolve) => {
      if (this.sessionCleanupInterval) {
        clearInterval(this.sessionCleanupInterval);
      }
      
      // Clear all pending responses
      for (const [sessionId, pending] of this.pendingResponses.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Server shutting down'));
      }
      this.pendingResponses.clear();
      
      if (this.server) {
        this.server.close(() => {
          console.log('HTTPS server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle incoming HTTP request
   */
  async handleRequest(req, res) {
    // Add CORS headers
    this.setCORSHeaders(res);
    
    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    // Rate limiting
    const clientIp = req.socket.remoteAddress;
    if (this.isRateLimited(clientIp)) {
      this.sendError(res, 429, 'Too many requests');
      return;
    }
    
    // Route handling
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (req.method === 'GET' && url.pathname === '/api/coordinator-key') {
      await this.handleGetCoordinatorKey(req, res);
    } else if (req.method === 'POST' && url.pathname === '/api/servers') {
      await this.handleListServers(req, res);
    } else if (req.method === 'POST' && url.pathname === '/api/connect') {
      await this.handleConnect(req, res);
    } else if (req.method === 'POST' && url.pathname === '/api/poll') {
      await this.handlePoll(req, res);
    } else {
      this.sendError(res, 404, 'Not found');
    }
  }

  /**
   * Set CORS headers
   */
  setCORSHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  /**
   * Check rate limiting
   */
  isRateLimited(ip) {
    const now = Date.now();
    const limit = this.rateLimitMap.get(ip);
    
    if (!limit || now > limit.resetTime) {
      this.rateLimitMap.set(ip, {
        count: 1,
        resetTime: now + 60000
      });
      return false;
    }
    
    limit.count++;
    
    if (limit.count > this.maxRequestsPerMinute) {
      return true;
    }
    
    return false;
  }

  /**
   * Read request body
   */
  async readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
        if (body.length > 100000) { // 100KB limit
          req.connection.destroy();
          reject(new Error('Request body too large'));
        }
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Send JSON response
   */
  sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  /**
   * Send error response
   */
  sendError(res, statusCode, message) {
    this.sendJSON(res, statusCode, { error: message });
  }

  /**
   * GET /api/coordinator-key
  * Returns coordinator's Ed25519/Ed448 public key with self-signature
   */
  async handleGetCoordinatorKey(req, res) {
    // Send unwrapped (base64) key for network efficiency
    const publicKeyBase64 = unwrapPublicKey(this.coordinatorKeys.publicKey);
    
    // Create self-signature (sign the base64 version)
    const data = { publicKey: publicKeyBase64 };
    const signature = signData(data, this.coordinatorKeys.privateKey);
    
    this.sendJSON(res, 200, {
      publicKey: publicKeyBase64,
      signature,
      signatureAlgorithm: this.signatureAlgorithm
    });
  }

  /**
   * POST /api/servers
   * Lists available servers
   */
  async handleListServers(req, res) {
    try {
      const body = await this.readBody(req);
      const { serverPublicKeys } = body;
      
      if (!Array.isArray(serverPublicKeys)) {
        this.sendError(res, 400, 'serverPublicKeys must be an array');
        return;
      }
      
      const servers = [];
      
      for (const keyPem of serverPublicKeys) {
        // Convert PEM to base64 for registry lookup
        const keyBase64 = unwrapPublicKey(keyPem);
        const server = this.registry.getServerByPublicKey(keyBase64);
        if (server) {
          const now = Date.now();
          const isOnline = (now - server.timestamp) < 60000; // Online if seen in last 60s
          
          servers.push({
            publicKeyHash: keyBase64,
            name: keyBase64.substring(0, 16) + '...', // Truncated hash as name
            online: isOnline,
            challenge: server.challenge
          });
        }
      }
      
      const response = { servers };
      const signature = signData(response, this.coordinatorKeys.privateKey);
      
      this.sendJSON(res, 200, {
        ...response,
        signature,
        coordinatorSignatureAlgorithm: this.signatureAlgorithm
      });
    } catch (err) {
      console.error('Error in handleListServers:', err);
      this.sendError(res, 400, err.message);
    }
  }

  /**
   * POST /api/connect
   * Initiates connection to a server
   */
  async handleConnect(req, res) {
    try {
      const body = await this.readBody(req);
      const { serverPublicKey: serverPublicKeyPem, challengeAnswer, payload, timestamp } = body;
      
      // Validate input
      if (!serverPublicKeyPem || !challengeAnswer || !payload) {
        this.sendError(res, 400, 'Missing required fields');
        return;
      }
      
      if (!payload.sdp || !Array.isArray(payload.candidates)) {
        this.sendError(res, 400, 'Invalid payload format');
        return;
      }
      
      // Check timestamp (prevent replay attacks)
      if (!timestamp || Math.abs(Date.now() - timestamp) > 60000) {
        this.sendError(res, 400, 'Invalid or expired timestamp');
        return;
      }
      
      // Convert PEM to base64 for registry lookup
      const serverPublicKey = unwrapPublicKey(serverPublicKeyPem);
      
      // Get server info
      const server = this.registry.getServerByPublicKey(serverPublicKey);
      if (!server) {
        this.sendError(res, 404, 'Server not found');
        return;
      }
      
      // Verify challenge answer
      if (!this.registry.verifyChallenge(serverPublicKey, challengeAnswer)) {
        this.sendError(res, 403, 'Invalid challenge answer');
        return;
      }
      
      // Generate unique session ID
      const sessionId = crypto.randomBytes(16).toString('hex');
      
      // Store session
      this.sessions.set(sessionId, {
        clientOffer: payload,
        timestamp: Date.now(),
        serverPublicKey,
        answer: null
      });
      
      // Relay offer to server via UDP
      try {
        await this.udpServer.sendOfferToServer(server.ipPort, sessionId, payload);
      } catch (err) {
        console.error('Error sending offer to server:', err);
        this.sessions.delete(sessionId);
        this.sendError(res, 500, 'Failed to relay offer to server');
        return;
      }
      
      // Respond with session ID
      const response = {
        success: true,
        sessionId,
        message: 'Waiting for server response'
      };
      
      const coordinatorSignature = signData(response, this.coordinatorKeys.privateKey);
      
      this.sendJSON(res, 200, {
        ...response,
        coordinatorSignature,
        coordinatorSignatureAlgorithm: this.signatureAlgorithm
      });
    } catch (err) {
      console.error('Error in handleConnect:', err);
      this.sendError(res, 400, err.message);
    }
  }

  /**
   * POST /api/poll
   * Poll for server response
   */
  async handlePoll(req, res) {
    try {
      const body = await this.readBody(req);
      const { sessionId, lastUpdate } = body;
      
      if (!sessionId) {
        this.sendError(res, 400, 'Missing sessionId');
        return;
      }
      
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.sendError(res, 404, 'Session not found');
        return;
      }
      
      // Check if session expired
      if (Date.now() - session.timestamp > this.sessionTimeout) {
        this.sessions.delete(sessionId);
        this.sendError(res, 408, 'Session expired');
        return;
      }
      
      // Check if answer is available
      if (session.answer) {
        const response = {
          success: true,
          payload: session.answer.payload,
          serverSignature: session.answer.signature,
          serverSignatureAlgorithm: session.answer.signatureAlgorithm
        };
        
        const coordinatorSignature = signData(response, this.coordinatorKeys.privateKey);
        
        // Clean up session after successful poll
        this.sessions.delete(sessionId);
        
        this.sendJSON(res, 200, {
          ...response,
          coordinatorSignature,
          coordinatorSignatureAlgorithm: this.signatureAlgorithm
        });
      } else {
        // Still waiting
        const response = {
          success: false,
          waiting: true
        };
        
        const coordinatorSignature = signData(response, this.coordinatorKeys.privateKey);
        
        this.sendJSON(res, 200, {
          ...response,
          coordinatorSignature,
          coordinatorSignatureAlgorithm: this.signatureAlgorithm
        });
      }
    } catch (err) {
      console.error('Error in handlePoll:', err);
      this.sendError(res, 400, err.message);
    }
  }

  /**
   * Store server answer for a session
   * Called by UDP server when server responds
   */
  storeServerAnswer(sessionId, payload, signature, signatureAlgorithm) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.answer = { payload, signature, signatureAlgorithm };
    }
  }

  /**
   * Cleanup expired sessions
   */
  cleanupSessions() {
    const now = Date.now();
    const expiredSessions = [];
    
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.timestamp > this.sessionTimeout) {
        expiredSessions.push(sessionId);
      }
    }
    
    expiredSessions.forEach(sessionId => {
      this.sessions.delete(sessionId);
    });
    
    if (expiredSessions.length > 0) {
      console.log(`Cleaned up ${expiredSessions.length} expired sessions`);
    }
    
    // Cleanup rate limit map
    const expiredIps = [];
    for (const [ip, limit] of this.rateLimitMap.entries()) {
      if (now > limit.resetTime + 60000) { // Keep for extra minute
        expiredIps.push(ip);
      }
    }
    
    expiredIps.forEach(ip => this.rateLimitMap.delete(ip));
  }
}
