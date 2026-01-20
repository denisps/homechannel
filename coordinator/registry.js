/**
 * Memory-compact server registry with dual-index for O(1) lookups
 * Map: serverPublicKey -> { ipPort, challenge, expectedAnswer, timestamp }
 * Index: ipPort -> serverPublicKey (for fast reverse lookup)
 */

export class ServerRegistry {
  constructor(options = {}) {
    this.servers = new Map();
    this.ipPortIndex = new Map(); // ipPort -> serverPublicKey for O(1) lookup
    this.connectionLog = new Map(); // For rate limiting
    this.serverTimeout = options.serverTimeout || 300000; // 5 minutes
    this.maxServers = options.maxServers || 1000;
    
    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000).unref(); // Every minute, unref so it doesn't keep event loop alive
  }

  /**
   * Register a server
   */
  register(serverPublicKey, ipPort, challenge, expectedAnswer) {
    if (this.servers.size >= this.maxServers && !this.servers.has(serverPublicKey)) {
      throw new Error('Maximum server limit reached');
    }

    // Remove old ipPort index if re-registering with different IP
    const existingServer = this.servers.get(serverPublicKey);
    if (existingServer && existingServer.ipPort !== ipPort) {
      this.ipPortIndex.delete(existingServer.ipPort);
    }

    this.servers.set(serverPublicKey, {
      ipPort,
      challenge,
      expectedAnswer,
      timestamp: Date.now()
    });

    // Maintain ipPort index
    this.ipPortIndex.set(ipPort, serverPublicKey);

    return true;
  }

  /**
   * Update server timestamp (for keepalive)
   * Optimized with O(1) lookup via ipPortIndex
   */
  updateTimestamp(ipPort) {
    const serverPublicKey = this.ipPortIndex.get(ipPort);
    if (!serverPublicKey) {
      return false;
    }
    
    const server = this.servers.get(serverPublicKey);
    if (server) {
      server.timestamp = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Update challenge (for challenge refresh)
   * Optimized with O(1) lookup via ipPortIndex
   */
  updateChallenge(ipPort, newChallenge, newExpectedAnswer) {
    const serverPublicKey = this.ipPortIndex.get(ipPort);
    if (!serverPublicKey) {
      return false;
    }
    
    const server = this.servers.get(serverPublicKey);
    if (server) {
      server.challenge = newChallenge;
      server.expectedAnswer = newExpectedAnswer;
      server.timestamp = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Get server by IP:port
   * Optimized with O(1) lookup via ipPortIndex
   */
  getServerByIpPort(ipPort) {
    const serverPublicKey = this.ipPortIndex.get(ipPort);
    if (!serverPublicKey) {
      return null;
    }
    
    const server = this.servers.get(serverPublicKey);
    if (server) {
      return { publicKey: serverPublicKey, ...server };
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
   * Optimized with O(1) lookup via ipPortIndex
   */
  getExpectedAnswer(ipPort) {
    const serverPublicKey = this.ipPortIndex.get(ipPort);
    if (!serverPublicKey) {
      return null;
    }
    
    const server = this.servers.get(serverPublicKey);
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
    const server = this.servers.get(serverPublicKey);
    if (server) {
      this.ipPortIndex.delete(server.ipPort);
      return this.servers.delete(serverPublicKey);
    }
    return false;
  }

  /**
   * Remove server by IP:port
   * Optimized with O(1) lookup via ipPortIndex
   */
  removeByIpPort(ipPort) {
    const serverPublicKey = this.ipPortIndex.get(ipPort);
    if (!serverPublicKey) {
      return false;
    }
    
    this.ipPortIndex.delete(ipPort);
    return this.servers.delete(serverPublicKey);
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

    expiredKeys.forEach(key => {
      const server = this.servers.get(key);
      if (server) {
        this.ipPortIndex.delete(server.ipPort);
      }
      this.servers.delete(key);
    });

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
    this.ipPortIndex.clear();
    this.connectionLog.clear();
  }
}
