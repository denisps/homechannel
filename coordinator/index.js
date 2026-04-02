import { promises as fsPromises } from 'fs';
import path from 'path';
import { ServerRegistry } from './registry.js';
import { UDPServer } from '../shared/protocol.js';
import { loadKeys, generateSigningKeyPair, saveKeys, normalizeSignatureAlgorithm, loadTLSCertificates } from '../shared/keys.js';
import { normalizeKeyAgreementCurve } from '../shared/crypto.js';
import { HTTPSServer } from './https.js';

// Config and key paths — always under ~/.config/homechannel/
const _CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '/root', '.config', 'homechannel');
const _CONFIG_PATH = path.join(_CONFIG_DIR, 'coordinator.json');
const _PRIVATE_KEY_PATH = path.join(_CONFIG_DIR, 'coordinator.key');
const _PUBLIC_KEY_PATH = path.join(_CONFIG_DIR, 'coordinator.pub');

const _DEFAULT_COORDINATOR_CONFIG = {
  udp: {
    port: 3478
  },
  https: {
    port: 8443,
    host: '0.0.0.0'
  },
  crypto: {
    signatureAlgorithm: 'ed25519',
    keyAgreementCurve: 'x25519'
  },
  serverTimeout: 120000,
  maxServers: 100
};

/**
 * HomeChannel Coordinator
 * Signaling server for WebRTC datachannel connections
 */

class Coordinator {
  constructor(config) {
    this.config = config;
    this.registry = null;
    this.udpServer = null;
    this.httpsServer = null;
    this.coordinatorKeys = null;
  }

  async init() {
    const keyLoadPromise = loadKeys(this.config.privateKeyPath, this.config.publicKeyPath);
    const tlsLoadPromise = (this.config.https?.certPath && this.config.https?.keyPath)
      ? loadTLSCertificates(this.config.https.certPath, this.config.https.keyPath)
      : Promise.resolve({});

    const signatureAlgorithm = normalizeSignatureAlgorithm(this.config.crypto?.signatureAlgorithm) || 'ed25519';
    const keyAgreementCurve = normalizeKeyAgreementCurve(this.config.crypto?.keyAgreementCurve) || 'x25519';

    this.signatureAlgorithm = signatureAlgorithm;
    this.keyAgreementCurve = keyAgreementCurve;

    // Load or generate coordinator keys
    try {
      this.coordinatorKeys = await keyLoadPromise;
      
      if (this.coordinatorKeys) {
        if (
          this.coordinatorKeys.signatureAlgorithm &&
          this.coordinatorKeys.signatureAlgorithm !== signatureAlgorithm
        ) {
          console.warn(
            `Coordinator keys are ${this.coordinatorKeys.signatureAlgorithm}, expected ${signatureAlgorithm}. ` +
            'Regenerating keys with the configured algorithm.'
          );
          this.coordinatorKeys = null;
        }
        if (this.coordinatorKeys) {
          this.coordinatorKeys.signatureAlgorithm = signatureAlgorithm;
          console.log('Loaded coordinator keys');
        }
      } else {
        console.log('Generating new coordinator keys...');
        this.coordinatorKeys = generateSigningKeyPair(signatureAlgorithm);
        saveKeys(this.config.privateKeyPath, this.config.publicKeyPath, this.coordinatorKeys);
        console.log('Coordinator keys generated and saved');
      }

      if (!this.coordinatorKeys) {
        console.log('Generating new coordinator keys...');
        this.coordinatorKeys = generateSigningKeyPair(signatureAlgorithm);
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
      port: this.config.udp.port,
      keyAgreementCurve,
      signatureAlgorithm
    });

    const tlsOptions = await tlsLoadPromise;

    // Initialize HTTPS server with TLS config from config file
    this.httpsServer = new HTTPSServer({
      port: this.config.https.port,
      host: this.config.https.host,
      ...tlsOptions,
      signatureAlgorithm,
      relayOffer: async ({ ipPort, sessionId, payload }) => {
        await this.udpServer.sendOfferToServer(ipPort, sessionId, payload);
      },
      getServerByPublicKey: (publicKey) => this.registry.getServerByPublicKey(publicKey),
      verifyChallenge: (publicKey, answer) => this.registry.verifyChallenge(publicKey, answer)
    });

    // Register answer handler to relay to HTTPS clients
    this.udpServer.on('answer', (answerData, sessionId) => {
      if (this.httpsServer) {
        this.httpsServer.storeServerAnswer(
          sessionId,
          answerData.serverPublicKey,
          answerData.payload,
          answerData.signature,
          answerData.signatureAlgorithm,
          answerData.timestamp
        );
      }
    });

    console.log('Coordinator initialized');
  }

  async start() {
    await this.init();
    await this.udpServer.start();
    await this.httpsServer.start();
    
    console.log('Coordinator started');
    console.log(`UDP port: ${this.config.udp.port}`);
    console.log(`HTTPS port: ${this.config.https.port}`);
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
    
    if (this.httpsServer) {
      await this.httpsServer.stop();
    }
    
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
          await fsPromises.writeFile(_CONFIG_PATH, JSON.stringify(_DEFAULT_COORDINATOR_CONFIG, null, 2), { mode: 0o600 });
          config = JSON.parse(JSON.stringify(_DEFAULT_COORDINATOR_CONFIG));
        } else {
          throw err;
        }
      }
    } catch (error) {
      console.error('Error loading config:', error);
      process.exit(1);
    }

    // Inject key paths — not stored in config file
    config.privateKeyPath = _PRIVATE_KEY_PATH;
    config.publicKeyPath = _PUBLIC_KEY_PATH;

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
  })();
}

export { Coordinator };
