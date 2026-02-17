import fs from 'fs';
import { ServerRegistry } from './registry.js';
import { UDPServer } from '../shared/protocol.js';
import { loadKeys, generateSigningKeyPair, saveKeys, normalizeSignatureAlgorithm, loadTLSCertificates } from '../shared/keys.js';
import { normalizeKeyAgreementCurve } from '../shared/crypto.js';
import { HTTPSServer } from './https.js';

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

    const signatureAlgorithm = normalizeSignatureAlgorithm(this.config.crypto?.signatureAlgorithm) || 'ed448';
    const keyAgreementCurve = normalizeKeyAgreementCurve(this.config.crypto?.keyAgreementCurve) || 'x448';

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
    this.httpsServer = new HTTPSServer(this.registry, this.coordinatorKeys, {
      port: this.config.https.port,
      host: this.config.https.host,
      ...tlsOptions,
      signatureAlgorithm,
      relayOffer: async ({ ipPort, sessionId, payload }) => {
        await this.udpServer.sendOfferToServer(ipPort, sessionId, payload);
      }
    });

    // Register answer handler to relay to HTTPS clients
    this.udpServer.on('answer', (answerData, sessionId) => {
      if (this.httpsServer) {
        this.httpsServer.storeServerAnswer(
          sessionId,
          answerData.payload,
          answerData.signature,
          answerData.signatureAlgorithm
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
  // Load config
  let config;
  try {
    config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
  } catch (error) {
    console.error('Error loading config:', error);
    console.error('Make sure config.json exists in the coordinator directory');
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
