import dgram from 'dgram';
import { verifySignature, verifyHMAC } from './crypto.js';

/**
 * UDP server for server-coordinator communication
 */
export class UDPServer {
  constructor(registry, coordinatorKeys, options = {}) {
    this.registry = registry;
    this.coordinatorKeys = coordinatorKeys;
    this.port = options.port || 3478;
    this.socket = null;
    this.messageHandlers = new Map();
  }

  /**
   * Start UDP server
   */
  start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        console.error('UDP server error:', err);
        reject(err);
      });

      this.socket.on('message', (msg, rinfo) => {
        this.handleMessage(msg, rinfo);
      });

      this.socket.on('listening', () => {
        const address = this.socket.address();
        console.log(`UDP server listening on ${address.address}:${address.port}`);
        resolve();
      });

      this.socket.bind(this.port);
    });
  }

  /**
   * Handle incoming UDP message
   */
  handleMessage(msg, rinfo) {
    try {
      const message = JSON.parse(msg.toString());
      const ipPort = `${rinfo.address}:${rinfo.port}`;

      switch (message.type) {
        case 'register':
          this.handleRegister(message, ipPort, rinfo);
          break;
        case 'ping':
          this.handlePing(ipPort, rinfo);
          break;
        case 'heartbeat':
          this.handleHeartbeat(message, ipPort, rinfo);
          break;
        case 'answer':
          this.handleAnswer(message, ipPort, rinfo);
          break;
        default:
          console.warn(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error('Error handling UDP message:', error.message);
    }
  }

  /**
   * Handle server registration
   */
  handleRegister(message, ipPort, rinfo) {
    const { serverPublicKey, timestamp, payload, signature } = message;

    if (!serverPublicKey || !payload || !signature) {
      console.error('Invalid registration message');
      return;
    }

    // Verify ECDSA signature
    const dataToVerify = { serverPublicKey, timestamp, payload };
    if (!verifySignature(dataToVerify, signature, serverPublicKey)) {
      console.error('Invalid signature in registration');
      return;
    }

    // Register server
    const { challenge, challengeAnswerHash } = payload;
    try {
      this.registry.register(serverPublicKey, ipPort, challenge, challengeAnswerHash);
      console.log(`Server registered: ${serverPublicKey.substring(0, 20)}... at ${ipPort}`);

      // Send acknowledgment
      this.sendResponse(rinfo, { status: 'ok', type: 'register' });

      // Emit event for testing
      if (this.messageHandlers.has('register')) {
        this.messageHandlers.get('register')(message, ipPort);
      }
    } catch (error) {
      console.error('Error registering server:', error.message);
      this.sendResponse(rinfo, { status: 'error', message: error.message });
    }
  }

  /**
   * Handle keepalive ping
   */
  handlePing(ipPort, rinfo) {
    // Update timestamp for server
    const updated = this.registry.updateTimestamp(ipPort);
    
    if (updated) {
      // No response needed for ping (minimal overhead)
      if (this.messageHandlers.has('ping')) {
        this.messageHandlers.get('ping')(ipPort);
      }
    }
  }

  /**
   * Handle challenge refresh heartbeat
   */
  handleHeartbeat(message, ipPort, rinfo) {
    const { payload, hmac } = message;

    if (!payload || !hmac) {
      console.error('Invalid heartbeat message');
      return;
    }

    // Get expected answer (shared secret) for this server
    const expectedAnswer = this.registry.getExpectedAnswer(ipPort);
    if (!expectedAnswer) {
      console.error('Server not found for heartbeat');
      return;
    }

    // Verify HMAC using expectedAnswer as key
    if (!verifyHMAC(payload, hmac, expectedAnswer)) {
      console.error('Invalid HMAC in heartbeat');
      return;
    }

    // Update challenge
    const { newChallenge, challengeAnswerHash } = payload;
    this.registry.updateChallenge(ipPort, newChallenge, challengeAnswerHash);
    
    // Emit event for testing
    if (this.messageHandlers.has('heartbeat')) {
      this.messageHandlers.get('heartbeat')(message, ipPort);
    }
  }

  /**
   * Handle SDP answer from server
   */
  handleAnswer(message, ipPort, rinfo) {
    const { serverPublicKey, sessionId, timestamp, payload, signature } = message;

    if (!serverPublicKey || !sessionId || !payload || !signature) {
      console.error('Invalid answer message');
      return;
    }

    // Verify ECDSA signature
    const dataToVerify = { serverPublicKey, sessionId, timestamp, payload };
    if (!verifySignature(dataToVerify, signature, serverPublicKey)) {
      console.error('Invalid signature in answer');
      return;
    }

    // Emit event for testing/relay
    if (this.messageHandlers.has('answer')) {
      this.messageHandlers.get('answer')(message, sessionId);
    }
  }

  /**
   * Send response to client
   */
  sendResponse(rinfo, data) {
    const message = Buffer.from(JSON.stringify(data));
    this.socket.send(message, rinfo.port, rinfo.address, (err) => {
      if (err) {
        console.error('Error sending UDP response:', err);
      }
    });
  }

  /**
   * Send message to server
   */
  sendToServer(ipPort, data) {
    const [address, port] = ipPort.split(':');
    const message = Buffer.from(JSON.stringify(data));
    
    return new Promise((resolve, reject) => {
      this.socket.send(message, parseInt(port), address, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Register message handler (for testing and relay)
   */
  on(type, handler) {
    this.messageHandlers.set(type, handler);
  }

  /**
   * Stop UDP server
   */
  stop() {
    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.close(() => {
          console.log('UDP server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
