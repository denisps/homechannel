import fs from 'fs';
import { ServerRegistry } from './registry.js';
import { UDPServer } from '../shared/protocol.js';
import { loadKeys, generateECDSAKeyPair, saveKeys } from '../shared/keys.js';

/**
 * HomeChannel Coordinator
 * Signaling server for WebRTC datachannel connections
 */

class Coordinator {
  constructor(config) {
    this.config = config;
    this.registry = null;
    this.udpServer = null;
    this.coordinatorKeys = null;
  }

  async init() {
    // Load or generate coordinator keys
    try {
      this.coordinatorKeys = loadKeys(this.config.privateKeyPath, this.config.publicKeyPath);
      
      if (this.coordinatorKeys) {
        console.log('Loaded coordinator keys');
      } else {
        console.log('Generating new coordinator keys...');
        this.coordinatorKeys = generateECDSAKeyPair();
        saveKeys(this.config.privateKeyPath, this.config.publicKeyPath, this.coordinatorKeys);
        console.log('Coordinator keys generated and saved');
      }
    } catch (error) {
      console.error('Error loading/generating keys:', error);
      throw error;
    }

    // Initialize registry
    this.registry = new ServerRegistry({
      serverTimeout: this.config.serverTimeout,
      maxServers: this.config.maxServers
    });

    // Initialize UDP server
    this.udpServer = new UDPServer(this.registry, this.coordinatorKeys, {
      port: this.config.udp.port
    });

    console.log('Coordinator initialized');
  }

  async start() {
    await this.init();
    await this.udpServer.start();
    
    console.log('Coordinator started');
    console.log(`UDP port: ${this.config.udp.port}`);
    console.log(`Max servers: ${this.config.maxServers}`);
    console.log(`Server timeout: ${this.config.serverTimeout}ms`);

    // Log stats periodically
    setInterval(() => {
      const stats = this.registry.getStats();
      console.log(`Stats: ${stats.totalServers} servers, ${stats.connectionLogSize} connection logs`);
    }, 60000);
  }

  async stop() {
    console.log('Stopping coordinator...');
    
    if (this.udpServer) {
      await this.udpServer.stop();
    }
    
    if (this.registry) {
      this.registry.destroy();
    }

    console.log('Coordinator stopped');
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
      throw new Error('No config file found');
    }
  } catch (error) {
    console.error('Error loading config:', error);
    process.exit(1);
  }

  const coordinator = new Coordinator(config);

  // Handle shutdown gracefully
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down...');
    await coordinator.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down...');
    await coordinator.stop();
    process.exit(0);
  });

  // Start coordinator
  coordinator.start().catch((error) => {
    console.error('Error starting coordinator:', error);
    process.exit(1);
  });
}

export { Coordinator };
