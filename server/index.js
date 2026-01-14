import fs from 'fs';
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

    console.log('Server initialized');
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
  } catch (error) {
    console.error('Error loading config:', error);
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
