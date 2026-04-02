import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { UDPClient } from '../shared/protocol.js';
import { createWebRTCPeer, displayWebRTCStatus } from './webrtc.js';
import { loadKeys, generateSigningKeyPair, saveKeys, normalizeSignatureAlgorithm } from '../shared/keys.js';
import { normalizeKeyAgreementCurve } from '../shared/crypto.js';
import { ServiceRouter } from './services/index.js';

// Config and key paths — always under ~/.config/homechannel/
const _CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '/root', '.config', 'homechannel');
const _CONFIG_PATH = path.join(_CONFIG_DIR, 'server.json');
const _PRIVATE_KEY_PATH = path.join(_CONFIG_DIR, 'server.key');
const _PUBLIC_KEY_PATH = path.join(_CONFIG_DIR, 'server.pub');
const _FAILOVER_PATH = path.join(_CONFIG_DIR, 'failover-coordinator.json');

const _DEFAULT_SERVER_CONFIG = {
  coordinator: {
    host: 'coordinator.example.com',
    port: 3478
  },
  crypto: {
    signatureAlgorithm: 'ed25519',
    keyAgreementCurve: 'x25519'
  },
  password: 'change-me',
  // udpLocalPort: 0 (uncomment and set to a fixed port to keep NAT mapping stable)
  apps: [],
  services: {}
};

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
    this.serviceRouter = null; // Service router for datachannel messages
  }

  async init() {
    const keyLoadPromise = loadKeys(this.config.privateKeyPath, this.config.publicKeyPath);

    // Display WebRTC library status
    await displayWebRTCStatus();

    const signatureAlgorithm = normalizeSignatureAlgorithm(this.config.crypto?.signatureAlgorithm) || 'ed25519';
    const keyAgreementCurve = normalizeKeyAgreementCurve(this.config.crypto?.keyAgreementCurve) || 'x25519';

    this.signatureAlgorithm = signatureAlgorithm;
    this.keyAgreementCurve = keyAgreementCurve;

    // Load or generate server keys
    try {
      this.serverKeys = await keyLoadPromise;
      
      if (this.serverKeys) {
        if (this.serverKeys.signatureAlgorithm && this.serverKeys.signatureAlgorithm !== signatureAlgorithm) {
          console.warn(
            `Server keys are ${this.serverKeys.signatureAlgorithm}, expected ${signatureAlgorithm}. ` +
            'Regenerating keys with the configured algorithm.'
          );
          this.serverKeys = null;
        }
        if (this.serverKeys) {
          this.serverKeys.signatureAlgorithm = signatureAlgorithm;
          console.log('Loaded server keys');
        }
      } else {
        console.log('Generating new server keys...');
        this.serverKeys = generateSigningKeyPair(signatureAlgorithm);
        saveKeys(this.config.privateKeyPath, this.config.publicKeyPath, this.serverKeys);
        console.log('Server keys generated and saved');
      }

      if (!this.serverKeys) {
        console.log('Generating new server keys...');
        this.serverKeys = generateSigningKeyPair(signatureAlgorithm);
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
    await this.loadFailoverCoordinator();

    // Initialize service router
    this.serviceRouter = new ServiceRouter(this.config.services || {});

    // Load apps if configured
    const appNames = this.config.apps || [];
    if (appNames.length > 0) {
      const { errors } = await this.serviceRouter.loadApps(
        appNames,
        this.config.appsConfig || {}
      );
      for (const err of errors) {
        console.warn(`App load error [${err.name}]: ${err.error}`);
      }
    }

    // Initialize UDP client
    this.udpClient = new UDPClient(
      this.config.coordinator.host,
      this.config.coordinator.port,
      this.serverKeys,
      {
        coordinatorPublicKey: this.config.coordinator.publicKey || null,
        keyAgreementCurve,
        helloMaxRetries: 10000,
        signatureAlgorithm,
        localPort: this.config.udpLocalPort || 0,
      }
    );

    // Register event handlers
    this.udpClient.on('registered', () => {
      console.log('Server registered with coordinator');
    });

    this.udpClient.on('migrate', (newCoordinator) => {
      this.handleMigration(newCoordinator);
    });

    this.udpClient.on('offer', ({ sessionId, payload }) => {
      this.handleOffer(sessionId, payload).catch(err => {
        console.error('Error handling WebRTC offer:', err.message);
      });
    });

    console.log('Server initialized');
  }

  /**
   * Load failover coordinator from disk
   */
  async loadFailoverCoordinator() {
    const failoverPath = this.config._failoverPath || path.join(_CONFIG_DIR, 'failover-coordinator.json');
    
    try {
      const data = await fsPromises.readFile(failoverPath, 'utf8');
      this.failoverCoordinator = JSON.parse(data);
      console.log(`Loaded failover coordinator: ${this.failoverCoordinator.host}:${this.failoverCoordinator.port}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Error loading failover coordinator:', error.message);
      }
      this.failoverCoordinator = null;
    }
  }

  /**
   * Save failover coordinator to disk
   */
  async saveFailoverCoordinator() {
    const failoverPath = this.config._failoverPath || path.join(_CONFIG_DIR, 'failover-coordinator.json');
    
    try {
      if (this.failoverCoordinator) {
        await fsPromises.writeFile(
          failoverPath,
          JSON.stringify(this.failoverCoordinator, null, 2),
          {
            mode: 0o600 // Secure permissions
          }
        );
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
  async handleOffer(sessionId, offerPayload) {
    try {
      // Create or reuse peer connection
      if (!this.peers.has(sessionId)) {
        const libraryName = this.config.webrtc?.library || 'werift';
        const peer = await createWebRTCPeer(libraryName, {
          serviceRouter: this.serviceRouter,
          config: {
            iceServers: this.config.webrtc?.iceServers || []
          }
        });
        
        if (!peer) {
          throw new Error(`WebRTC library '${libraryName}' not available`);
        }
        
        this.peers.set(sessionId, peer);
      }

      const peer = this.peers.get(sessionId);

      // Set remote description (offer)
      await peer.handleOffer(offerPayload.sdp || offerPayload);

      // Add ICE candidates from the offer
      if (offerPayload.candidates) {
        for (const candidate of offerPayload.candidates) {
          await peer.addICECandidate(candidate).catch(() => {});
        }
      }

      // Create answer and set local description
      const answerSdp = await peer.createAnswer();

      // Wait for ICE gathering to complete
      await peer.waitForIceGathering(10000);

      const answer = {
        sessionId,
        sdp: answerSdp,
        candidates: peer.getICECandidates()
      };

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
      await this.saveFailoverCoordinator();
      
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
      newUdpClient.on('registered', async () => {
        console.log('Successfully registered with new coordinator');
        
        // Stop and dispose old client
        const oldClient = this.udpClient;
        
        // Switch to new client immediately
        this.udpClient = newUdpClient;
        
        // Stop old client after switching
        if (oldClient && oldClient !== newUdpClient) {
          try {
            await oldClient.stop();
            console.log('Old UDP client stopped and disposed');
          } catch (err) {
            console.error('Error stopping old UDP client:', err);
          }
        }
        
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
  (async () => {
    let config;
    try {
      await fsPromises.mkdir(_CONFIG_DIR, { recursive: true });
      try {
        const raw = await fsPromises.readFile(_CONFIG_PATH, 'utf8');
        config = JSON.parse(raw);
      } catch (err) {
        if (err.code === 'ENOENT') {
          console.log(`No config found. Creating default at ${_CONFIG_PATH}`);
          await fsPromises.writeFile(_CONFIG_PATH, JSON.stringify(_DEFAULT_SERVER_CONFIG, null, 2), { mode: 0o600 });
          config = JSON.parse(JSON.stringify(_DEFAULT_SERVER_CONFIG));
        } else {
          throw err;
        }
      }
    } catch (error) {
      console.error('Error loading config:', error);
      process.exit(1);
    }

    // Inject key and failover paths — not stored in config file
    config.privateKeyPath = _PRIVATE_KEY_PATH;
    config.publicKeyPath = _PUBLIC_KEY_PATH;
    config._failoverPath = _FAILOVER_PATH;

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
  })();
}

export { Server };
