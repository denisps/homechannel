/**
 * Memory-compact server registry
 * Map: serverPublicKey -> { ipPort, challenge, expectedAnswer, timestamp }
 */

export class ServerRegistry {
  constructor(options = {}) {
    this.servers = new Map();
    this.connectionLog = new Map(); // For rate limiting
    this.serverTimeout = options.serverTimeout || 300000; // 5 minutes
    this.maxServers = options.maxServers || 1000;
    
    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Every minute
  }

  /**
   * Register a server
   */
  register(serverPublicKey, ipPort, challenge, expectedAnswer) {
    if (this.servers.size >= this.maxServers && !this.servers.has(serverPublicKey)) {
      throw new Error('Maximum server limit reached');
    }

    this.servers.set(serverPublicKey, {
      ipPort,
      challenge,
      expectedAnswer,
      timestamp: Date.now()
    });

    return true;
  }

  /**
   * Update server timestamp (for keepalive)
   */
  updateTimestamp(ipPort) {
    for (const [key, server] of this.servers.entries()) {
      if (server.ipPort === ipPort) {
        server.timestamp = Date.now();
        return true;
      }
    }
    return false;
  }

  /**
   * Update challenge (for challenge refresh)
   */
  updateChallenge(ipPort, newChallenge, newExpectedAnswer) {
    for (const [key, server] of this.servers.entries()) {
      if (server.ipPort === ipPort) {
        server.challenge = newChallenge;
        server.expectedAnswer = newExpectedAnswer;
        server.timestamp = Date.now();
        return true;
      }
    }
    return false;
  }

  /**
   * Get server by IP:port
   */
  getServerByIpPort(ipPort) {
    for (const [key, server] of this.servers.entries()) {
      if (server.ipPort === ipPort) {
        return { publicKey: key, ...server };
      }
    }
    return null;
  }

  /**
   * Get server by public key
   */
  getServerByPublicKey(publicKey) {
    return this.servers.get(publicKey);
  }

  /**
   * Get expected answer for server
   */
  getExpectedAnswer(ipPort) {
    const server = this.getServerByIpPort(ipPort);
    return server ? server.expectedAnswer : null;
  }

  /**
   * Verify challenge answer
   */
  verifyChallenge(serverPublicKey, answer) {
    const server = this.servers.get(serverPublicKey);
    if (!server) {
      return false;
    }
    return server.expectedAnswer === answer;
  }

  /**
   * Get challenge for server
   */
  getChallenge(serverPublicKey) {
    const server = this.servers.get(serverPublicKey);
    return server ? server.challenge : null;
  }

  /**
   * Remove server
   */
  remove(serverPublicKey) {
    return this.servers.delete(serverPublicKey);
  }

  /**
   * Remove server by IP:port
   */
  removeByIpPort(ipPort) {
    for (const [key, server] of this.servers.entries()) {
      if (server.ipPort === ipPort) {
        this.servers.delete(key);
        return true;
      }
    }
    return false;
  }

  /**
   * Cleanup expired servers
   */
  cleanup() {
    const now = Date.now();
    const expiredKeys = [];

    for (const [key, server] of this.servers.entries()) {
      if (now - server.timestamp > this.serverTimeout) {
        expiredKeys.push(key);
      }
    }

    expiredKeys.forEach(key => this.servers.delete(key));

    if (expiredKeys.length > 0) {
      console.log(`Cleaned up ${expiredKeys.length} expired servers`);
    }

    return expiredKeys.length;
  }

  /**
   * Log connection attempt for rate limiting
   */
  logConnectionAttempt(clientId) {
    const now = Date.now();
    const attempts = this.connectionLog.get(clientId) || [];
    
    // Keep only attempts from last minute
    const recentAttempts = attempts.filter(t => now - t < 60000);
    recentAttempts.push(now);
    
    this.connectionLog.set(clientId, recentAttempts);
    
    return recentAttempts.length;
  }

  /**
   * Check if client is rate limited
   */
  isRateLimited(clientId, maxAttempts = 10) {
    const attempts = this.connectionLog.get(clientId) || [];
    const now = Date.now();
    const recentAttempts = attempts.filter(t => now - t < 60000);
    return recentAttempts.length >= maxAttempts;
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      totalServers: this.servers.size,
      connectionLogSize: this.connectionLog.size
    };
  }

  /**
   * Destroy registry and cleanup
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.servers.clear();
    this.connectionLog.clear();
  }
}
