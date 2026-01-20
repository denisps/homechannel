import fs from 'fs';
import path from 'path';
import { UDPClient } from '../shared/protocol.js';
import { WebRTCPeer } from './webrtc.js';
import { loadKeys, generateECDSAKeyPair, saveKeys } from '../shared/keys.js';

/**
 * HomeChannel Server
 * Runs on home network, connects to coordinator via UDP
 */

class Server {
  constructor(config) {
    this.config = config;
    this.serverKeys = null;
    this.udpClient = null;
    this.peers = new Map(); // clientId -> WebRTCPeer
    this.failoverCoordinator = null; // Store failover coordinator info
  }

  async init() {
    // Load or generate server keys
    try {
      this.serverKeys = loadKeys(this.config.privateKeyPath, this.config.publicKeyPath);
      
      if (this.serverKeys) {
        console.log('Loaded server keys');
      } else {
        console.log('Generating new server keys...');
        this.serverKeys = generateECDSAKeyPair();
        saveKeys(this.config.privateKeyPath, this.config.publicKeyPath, this.serverKeys);
        console.log('Server keys generated and saved');
      }
    } catch (error) {
      console.error('Error loading/generating keys:', error);
      throw error;
    }

    // Add password to keys object for UDP client
    this.serverKeys.password = this.config.password || 'default';

    // Load failover coordinator if it exists
    this.loadFailoverCoordinator();

    // Initialize UDP client
    this.udpClient = new UDPClient(
      this.config.coordinator.host,
      this.config.coordinator.port,
      this.serverKeys,
      {
        coordinatorPublicKey: this.config.coordinator.publicKey || null
      }
    );

    // Register event handlers
    this.udpClient.on('registered', () => {
      console.log('Server registered with coordinator');
    });

    this.udpClient.on('migrate', (newCoordinator) => {
      this.handleMigration(newCoordinator);
    });

    console.log('Server initialized');
  }

  /**
   * Load failover coordinator from disk
   */
  loadFailoverCoordinator() {
    const failoverPath = 'failover-coordinator.json';
    
    try {
      if (fs.existsSync(failoverPath)) {
        const data = fs.readFileSync(failoverPath, 'utf8');
        this.failoverCoordinator = JSON.parse(data);
        console.log(`Loaded failover coordinator: ${this.failoverCoordinator.host}:${this.failoverCoordinator.port}`);
      }
    } catch (error) {
      console.warn('Error loading failover coordinator:', error.message);
      this.failoverCoordinator = null;
    }
  }

  /**
   * Save failover coordinator to disk
   */
  saveFailoverCoordinator() {
    const failoverPath = 'failover-coordinator.json';
    
    try {
      if (this.failoverCoordinator) {
        fs.writeFileSync(failoverPath, JSON.stringify(this.failoverCoordinator, null, 2), {
          mode: 0o600 // Secure permissions
        });
        console.log('Failover coordinator saved to disk');
      }
    } catch (error) {
      console.error('Error saving failover coordinator:', error.message);
    }
  }

  async start() {
    await this.init();
    await this.udpClient.start();
    
    console.log('Server started');
    console.log(`Coordinator: ${this.config.coordinator.host}:${this.config.coordinator.port}`);
  }

  /**
   * Handle incoming offer from client (via coordinator)
   */
  async handleOffer(clientId, sdpOffer) {
    try {
      // Create or reuse peer connection
      if (!this.peers.has(clientId)) {
        const peer = new WebRTCPeer();
        this.peers.set(clientId, peer);
      }

      const peer = this.peers.get(clientId);
      
      // Create answer
      const answer = await peer.createAnswer(sdpOffer);
      
      // Send answer back to coordinator
      await this.udpClient.sendAnswer(answer);
    } catch (error) {
      console.error('Error handling offer:', error);
      throw error;
    }
  }

  /**
   * Handle coordinator migration request
   * Save failover coordinator and attempt registration
   */
  async handleMigration(newCoordinator) {
    try {
      console.log(`Migration requested to ${newCoordinator.host}:${newCoordinator.port}`);
      
      // Save failover coordinator info
      this.failoverCoordinator = {
        host: newCoordinator.host,
        port: newCoordinator.port,
        publicKey: newCoordinator.publicKey,
        timestamp: Date.now()
      };
      
      // Persist to disk
      this.saveFailoverCoordinator();
      
      console.log('Failover coordinator saved for future use');
      
      // Create new UDP client for migration target
      const newUdpClient = new UDPClient(
        newCoordinator.host,
        newCoordinator.port,
        this.serverKeys,
        {
          coordinatorPublicKey: newCoordinator.publicKey
        }
      );
      
      // Register event handlers for new client
      newUdpClient.on('registered', () => {
        console.log('Successfully registered with new coordinator');
        
        // Stop old client
        if (this.udpClient) {
          this.udpClient.stop().catch(err => {
            console.error('Error stopping old UDP client:', err);
          });
        }
        
        // Switch to new client
        this.udpClient = newUdpClient;
        
        // Update config for persistence
        this.config.coordinator.host = newCoordinator.host;
        this.config.coordinator.port = newCoordinator.port;
        this.config.coordinator.publicKey = newCoordinator.publicKey;
      });
      
      // Attempt registration with new coordinator
      console.log('Attempting registration with new coordinator...');
      await newUdpClient.start();
      
    } catch (error) {
      console.error('Error during migration:', error);
      console.log('Continuing with current coordinator');
      // Don't throw - keep current connection alive on migration failure
    }
  }

  async stop() {
    console.log('Stopping server...');
    
    // Close all peer connections
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();

    // Stop UDP client
    if (this.udpClient) {
      await this.udpClient.stop();
    }

    console.log('Server stopped');
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  // Load config
  let config;
  try {
    config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
  } catch (error) {
    console.error('Error loading config:', error);
    console.error('Make sure config.json exists in the server directory');
    process.exit(1);
  }

  const server = new Server(config);
  
  server.start().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Terminating...');
    await server.stop();
    process.exit(0);
  });
}

export { Server };
