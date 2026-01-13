import fs from 'fs';
import { UDPClient } from '../shared/protocol.js';
import { WebRTCPeer } from './webrtc.js';
import { loadKeys, generateECDSAKeyPair } from '../shared/crypto.js';

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
      if (fs.existsSync(this.config.privateKeyPath) && fs.existsSync(this.config.publicKeyPath)) {
        this.serverKeys = loadKeys(this.config.privateKeyPath, this.config.publicKeyPath);
        console.log('Loaded server keys');
      } else {
        console.log('Generating new server keys...');
        this.serverKeys = generateECDSAKeyPair();
        
        // Create keys directory if it doesn't exist
        const keysDir = this.config.privateKeyPath.substring(0, this.config.privateKeyPath.lastIndexOf('/'));
        if (!fs.existsSync(keysDir)) {
          fs.mkdirSync(keysDir, { recursive: true });
        }
        
        // Save keys
        fs.writeFileSync(this.config.privateKeyPath, this.serverKeys.privateKey, { mode: 0o600 });
        fs.writeFileSync(this.config.publicKeyPath, this.serverKeys.publicKey);
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
    if (fs.existsSync('./config.json')) {
      config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    } else if (fs.existsSync('./config.example.json')) {
      config = JSON.parse(fs.readFileSync('./config.example.json', 'utf8'));
      console.log('Using example config (create config.json for production)');
    } else {
      console.error('No config found');
      process.exit(1);
    }
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
