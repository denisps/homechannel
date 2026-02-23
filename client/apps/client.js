/**
 * HomeChannel Client API
 * Universal module for WebRTC datachannel connections
 * Works as both ES module and script tag
 */

// ============================================================================
// Crypto Utilities (Browser Web Crypto API)
// ============================================================================

const cryptoAPI = globalThis.crypto;

const SIGNATURE_ALGORITHMS = {
  ed25519: {
    importParams: { name: 'Ed25519' },
    verifyParams: { name: 'Ed25519' }
  },
  ed448: {
    importParams: { name: 'Ed448' },
    verifyParams: { name: 'Ed448' }
  }
};

const DEFAULT_SIGNATURE_ALGORITHM = 'ed448';

function normalizeSignatureAlgorithm(algorithm) {
  if (!algorithm) {
    return DEFAULT_SIGNATURE_ALGORITHM;
  }

  const normalized = algorithm.toLowerCase();
  if (!SIGNATURE_ALGORITHMS[normalized]) {
    throw new Error(`Unsupported signature algorithm: ${algorithm}`);
  }

  return normalized;
}

  /**
   * Base64 decode that works in both browser and Node.js
   */
  function base64Decode(str) {
    if (typeof atob !== 'undefined') {
      // Browser environment
      return atob(str);
    } else if (typeof Buffer !== 'undefined') {
      // Node.js environment
      return Buffer.from(str, 'base64').toString('binary');
    }
    throw new Error('No base64 decoder available');
  }

  /**
   * Convert PEM or base64 public key to CryptoKey for signature verification
   */
  async function importPublicKey(key, signatureAlgorithm) {
    let pemContents;
    
    // Check if it's already PEM format or raw base64
    if (key.includes('-----BEGIN PUBLIC KEY-----')) {
      // PEM format - strip headers/footers
      pemContents = key
        .replace('-----BEGIN PUBLIC KEY-----', '')
        .replace('-----END PUBLIC KEY-----', '')
        .replace(/\s/g, '');
    } else {
      // Raw base64 format (already unwrapped)
      pemContents = key.replace(/\s/g, '');
    }
    
    const binaryDer = Uint8Array.from(base64Decode(pemContents), c => c.charCodeAt(0));
    
    const algorithm = normalizeSignatureAlgorithm(signatureAlgorithm);

    return await cryptoAPI.subtle.importKey(
      'spki',
      binaryDer,
      SIGNATURE_ALGORITHMS[algorithm].importParams,
      true,
      ['verify']
    );
  }

  /**
   * Verify Ed25519/Ed448 signature (browser version)
   */
  async function verifySignature(data, signature, publicKey, signatureAlgorithm) {
    try {
      const algorithm = normalizeSignatureAlgorithm(signatureAlgorithm);
      const cryptoKey = await importPublicKey(publicKey, algorithm);
      const encoder = new TextEncoder();
      const dataBuffer = encoder.encode(JSON.stringify(data));
      const signatureBuffer = hexToBytes(signature);
      
      return await cryptoAPI.subtle.verify(
        SIGNATURE_ALGORITHMS[algorithm].verifyParams,
        cryptoKey,
        signatureBuffer,
        dataBuffer
      );
    } catch (error) {
      console.error('Signature verification error:', error);
      return false;
    }
  }

  /**
   * Normalize a PEM or base64 public key to base64 for network requests
   */
  function normalizePublicKeyBase64(key) {
    if (key.includes('-----BEGIN PUBLIC KEY-----')) {
      return key
        .replace('-----BEGIN PUBLIC KEY-----', '')
        .replace('-----END PUBLIC KEY-----', '')
        .replace(/\s/g, '');
    }
    return key.replace(/\s/g, '');
  }

  /**
   * Hash challenge answer (browser version)
   */
  async function hashChallengeAnswer(challenge, password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(challenge + password);
    const hashBuffer = await cryptoAPI.subtle.digest('SHA-256', data);
    return bytesToHex(new Uint8Array(hashBuffer));
  }

  /**
   * Convert hex string to Uint8Array
   */
  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  /**
   * Convert Uint8Array to hex string
   */
  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  
/**
 * HomeChannel Client
 * Manages WebRTC peer connection and coordinator iframe communication
 */
class Client {
    constructor(coordinatorUrl) {
      this.coordinatorUrl = coordinatorUrl;
      this.iframe = null;
      this.peerConnection = null;
      this.dataChannel = null;
      this.serverPublicKey = null;
      this.sessionId = null;
      this.state = 'disconnected'; // disconnected, connecting, connected
      
      // Event handlers
      this.handlers = {
        connected: [],
        message: [],
        disconnected: [],
        error: [],
        appsLoaded: []
      };
      
      // Pending iframe requests
      this.iframeRequests = new Map();
      this.nextRequestId = 1;
      
      // ICE candidate gathering
      this.iceCandidates = [];
      this.iceGatheringComplete = false;

      // App channels
      this.controlChannel = null;
      this.appChannels = new Map();   // appName -> RTCDataChannel
      this.apps = [];                  // app list from server
      this.controlRequests = new Map(); // requestId -> { resolve, reject }
      this.appIframes = new Map();     // appName -> iframe element
    }
    
    /**
     * Register event handler
     */
    on(event, handler) {
      if (!this.handlers[event]) {
        throw new Error(`Unknown event: ${event}`);
      }
      this.handlers[event].push(handler);
    }
    
    /**
     * Emit event to all handlers
     */
    emit(event, data) {
      if (this.handlers[event]) {
        this.handlers[event].forEach(handler => {
          try {
            handler(data);
          } catch (error) {
            console.error(`Error in ${event} handler:`, error);
          }
        });
      }
    }
    
    /**
     * Connect to server
    * @param {string} serverPublicKey - Server's Ed25519/Ed448 public key (PEM format)
     * @param {string} password - Password for challenge-response authentication
     */
    async connect(serverPublicKey, password) {
      if (this.state !== 'disconnected') {
        throw new Error('Already connected or connecting');
      }
      
      try {
        this.state = 'connecting';
        this.serverPublicKey = serverPublicKey;
        
        // Create and setup iframe
        await this.createIframe();
        
        const serverPublicKeyBase64 = normalizePublicKeyBase64(serverPublicKey);

        // Get server challenge
        const serverInfo = await this.iframeRequest('getServerInfo', {
          serverPublicKey: serverPublicKeyBase64
        });
        
        if (!serverInfo.online) {
          throw new Error('Server is offline');
        }
        
        // Compute challenge answer
        const challengeAnswer = await hashChallengeAnswer(
          serverInfo.challenge,
          password
        );
        
        // Create WebRTC peer connection and offer
        await this.createPeerConnection();
        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);
        
        // Wait for ICE gathering to complete
        await this.waitForIceGathering();
        
        // Send connection request with offer and candidates
        const connectResponse = await this.iframeRequest('connect', {
          serverPublicKey: serverPublicKeyBase64,
          challengeAnswer,
          payload: {
            sdp: offer,
            candidates: this.iceCandidates
          }
        });
        
        this.sessionId = connectResponse.sessionId;
        
        // Poll for server's answer
        const answer = await this.pollForAnswer();
        
        // Verify server's signature on answer
        const answerValid = await verifySignature(
          {
            serverPublicKey: answer.serverPublicKey,
            sessionId: answer.sessionId,
            timestamp: answer.timestamp,
            payload: answer.payload
          },
          answer.serverSignature,
          serverPublicKey,
          answer.serverSignatureAlgorithm || DEFAULT_SIGNATURE_ALGORITHM
        );
        
        if (!answerValid) {
          throw new Error('Invalid server signature on answer');
        }
        
        // Set remote description and add ICE candidates
        await this.peerConnection.setRemoteDescription(answer.payload.sdp);
        
        for (const candidate of answer.payload.candidates) {
          await this.peerConnection.addIceCandidate(candidate);
        }
        
        // Wait for datachannel to open
        await this.waitForDataChannel();
        
        // Connection established - can delete iframe now
        this.destroyIframe();
        
        this.state = 'connected';
        this.emit('connected');
        
      } catch (error) {
        this.state = 'disconnected';
        this.destroyIframe();
        this.closePeerConnection();
        this.emit('error', error);
        throw error;
      }
    }
    
    /**
     * Send message over datachannel
     */
    send(message) {
      if (this.state !== 'connected') {
        throw new Error('Not connected');
      }
      
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
        throw new Error('DataChannel not open');
      }
      
      const data = typeof message === 'string' ? message : JSON.stringify(message);
      this.dataChannel.send(data);
    }
    
    /**
     * Disconnect and cleanup
     */
    disconnect() {
      this.state = 'disconnected';
      this.destroyIframe();
      this.closePeerConnection();
      this.emit('disconnected');
    }
    
    /**
     * Create coordinator iframe for signaling
     */
    async createIframe() {
      return new Promise((resolve, reject) => {
        this.iframe = document.createElement('iframe');
        this.iframe.src = `${this.coordinatorUrl}/iframe.html`;
        this.iframe.style.position = 'fixed';
        this.iframe.style.top = '0';
        this.iframe.style.left = '0';
        this.iframe.style.width = '100%';
        this.iframe.style.height = '100%';
        this.iframe.style.border = 'none';
        this.iframe.style.zIndex = '9999';
        
        this.iframe.onload = () => {
          // Setup postMessage handler
          window.addEventListener('message', this.handleIframeMessage.bind(this));
          resolve();
        };
        
        this.iframe.onerror = (error) => {
          reject(new Error('Failed to load coordinator iframe'));
        };
        
        document.body.appendChild(this.iframe);
      });
    }
    
    /**
     * Destroy coordinator iframe
     */
    destroyIframe() {
      if (this.iframe) {
        window.removeEventListener('message', this.handleIframeMessage.bind(this));
        document.body.removeChild(this.iframe);
        this.iframe = null;
      }
      
      // Clean up any pending iframe requests
      for (const [requestId, { reject }] of this.iframeRequests) {
        reject(new Error('Client disconnected'));
      }
      this.iframeRequests.clear();
    }
    
    /**
     * Send request to iframe and wait for response
     */
    iframeRequest(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = this.nextRequestId++;
        
        this.iframeRequests.set(requestId, { resolve, reject });
        
        this.iframe.contentWindow.postMessage({
          type: 'request',
          requestId,
          method,
          params
        }, this.coordinatorUrl);
        
        // Timeout after 30 seconds
        setTimeout(() => {
          if (this.iframeRequests.has(requestId)) {
            this.iframeRequests.delete(requestId);
            reject(new Error('Iframe request timeout'));
          }
        }, 30000);
      });
    }
    
    /**
     * Handle messages from iframe
     */
    handleIframeMessage(event) {
      // Verify origin
      if (!event.origin.startsWith(this.coordinatorUrl)) {
        return;
      }
      
      const { type, requestId, data, error } = event.data;
      
      if (type === 'response') {
        const pending = this.iframeRequests.get(requestId);
        if (pending) {
          this.iframeRequests.delete(requestId);
          if (error) {
            pending.reject(new Error(error));
          } else {
            pending.resolve(data);
          }
        }
      }
    }
    
    /**
     * Create WebRTC peer connection
     */
    async createPeerConnection() {
      this.peerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      });
      
      // Create datachannel
      this.dataChannel = this.peerConnection.createDataChannel('homechannel', {
        ordered: true
      });
      
      this.dataChannel.onopen = () => {
        // Will be handled by waitForDataChannel
      };
      
      this.dataChannel.onmessage = (event) => {
        this.emit('message', event.data);
      };
      
      this.dataChannel.onclose = () => {
        if (this.state === 'connected') {
          this.state = 'disconnected';
          this.emit('disconnected');
        }
      };
      
      this.dataChannel.onerror = (error) => {
        this.emit('error', error);
      };
      
      // Gather ICE candidates
      this.iceCandidates = [];
      this.iceGatheringComplete = false;
      
      this.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          this.iceCandidates.push({
            candidate: event.candidate.candidate,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            sdpMid: event.candidate.sdpMid
          });
        } else {
          // ICE gathering complete
          this.iceGatheringComplete = true;
        }
      };
      
      this.peerConnection.onconnectionstatechange = () => {
        if (this.peerConnection.connectionState === 'failed' ||
            this.peerConnection.connectionState === 'disconnected') {
          if (this.state === 'connected') {
            this.state = 'disconnected';
            this.emit('disconnected');
          }
        }
      };
    }
    
    /**
     * Wait for ICE gathering to complete
     */
    async waitForIceGathering() {
      return new Promise((resolve) => {
        if (this.iceGatheringComplete) {
          resolve();
          return;
        }
        
        const checkInterval = setInterval(() => {
          if (this.iceGatheringComplete) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
        
        // Timeout after 10 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve(); // Proceed with whatever candidates we have
        }, 10000);
      });
    }
    
    /**
     * Poll coordinator for server's answer
     */
    async pollForAnswer() {
      const maxAttempts = 60; // 60 attempts = 30 seconds
      
      for (let i = 0; i < maxAttempts; i++) {
        const response = await this.iframeRequest('poll', {
          sessionId: this.sessionId,
          lastUpdate: Date.now()
        });
        
        if (response.success && response.payload) {
          return response;
        }
        
        // Wait 500ms before next poll
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      throw new Error('Timeout waiting for server answer');
    }
    
    /**
     * Wait for datachannel to open
     */
    async waitForDataChannel() {
      return new Promise((resolve, reject) => {
        if (this.dataChannel.readyState === 'open') {
          resolve();
          return;
        }
        
        let timeoutId;
        
        const openHandler = () => {
          clearTimeout(timeoutId);
          if (this.dataChannel) {
            this.dataChannel.removeEventListener('open', openHandler);
            this.dataChannel.removeEventListener('error', errorHandler);
          }
          resolve();
        };
        
        const errorHandler = (error) => {
          clearTimeout(timeoutId);
          if (this.dataChannel) {
            this.dataChannel.removeEventListener('open', openHandler);
            this.dataChannel.removeEventListener('error', errorHandler);
          }
          reject(error);
        };
        
        this.dataChannel.addEventListener('open', openHandler);
        this.dataChannel.addEventListener('error', errorHandler);
        
        // Timeout after 10 seconds
        timeoutId = setTimeout(() => {
          if (this.dataChannel) {
            this.dataChannel.removeEventListener('open', openHandler);
            this.dataChannel.removeEventListener('error', errorHandler);
          }
          reject(new Error('DataChannel open timeout'));
        }, 10000);
      });
    }
    
    /**
     * Request app list over the apps-control channel
     * @returns {Promise<Array>} List of available apps
     */
    async requestAppList() {
      if (this.state !== 'connected' || !this.peerConnection) {
        throw new Error('Not connected');
      }

      // Create control channel if not already open
      if (!this.controlChannel || this.controlChannel.readyState !== 'open') {
        this.controlChannel = this.peerConnection.createDataChannel('apps-control', { ordered: true });
        await this._waitForChannelOpen(this.controlChannel);
        this._setupControlChannel();
      }

      const requestId = `ctrl_${this.nextRequestId++}`;
      const result = await new Promise((resolve, reject) => {
        this.controlRequests.set(requestId, { resolve, reject });

        this.controlChannel.send(JSON.stringify({
          type: 'apps:list',
          requestId
        }));

        setTimeout(() => {
          if (this.controlRequests.has(requestId)) {
            this.controlRequests.delete(requestId);
            reject(new Error('App list request timeout'));
          }
        }, 30000);
      });

      this.apps = result.apps || [];
      this.emit('appsLoaded', this.apps);
      return this.apps;
    }

    /**
     * Open a per-app datachannel
     * @param {string} appName - Name of the app
     * @returns {Promise<RTCDataChannel>} Opened datachannel
     */
    async openAppChannel(appName) {
      if (this.state !== 'connected' || !this.peerConnection) {
        throw new Error('Not connected');
      }

      if (appName === 'apps-control') {
        throw new Error('Cannot open reserved channel name: apps-control');
      }

      const channel = this.peerConnection.createDataChannel(appName, { ordered: true });
      await this._waitForChannelOpen(channel);
      this.appChannels.set(appName, channel);
      return channel;
    }

    /**
     * Load app bundle into a sandboxed iframe
     * @param {string} appName - Name of the app
     * @param {string} bundle - ES module bundle source
     * @param {HTMLElement} container - DOM container for the iframe
     * @returns {HTMLIFrameElement} Created iframe
     */
    loadAppInSandbox(appName, bundle, container) {
      const appIframe = document.createElement('iframe');
      appIframe.sandbox = 'allow-scripts';
      appIframe.style.width = '100%';
      appIframe.style.height = '100%';
      appIframe.style.border = 'none';
      appIframe.srcdoc = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><script type="module">${bundle}<\/script></body></html>`;

      container.appendChild(appIframe);
      this.appIframes.set(appName, appIframe);
      return appIframe;
    }

    /**
     * Internal: handle control channel messages
     */
    _handleControlMessage(data) {
      try {
        const message = typeof data === 'string' ? JSON.parse(data) : data;
        const pending = this.controlRequests.get(message.requestId);
        if (pending) {
          this.controlRequests.delete(message.requestId);
          if (message.error) {
            pending.reject(new Error(message.error));
          } else {
            pending.resolve(message);
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    }

    /**
     * Setup control channel message handler
     */
    _setupControlChannel() {
      if (this.controlChannel) {
        this.controlChannel.onmessage = (event) => {
          this._handleControlMessage(event.data);
        };
      }
    }

    /**
     * Wait for a datachannel to open
     * @param {RTCDataChannel} channel
     * @returns {Promise<void>}
     */
    _waitForChannelOpen(channel) {
      return new Promise((resolve, reject) => {
        if (channel.readyState === 'open') {
          resolve();
          return;
        }

        let timeoutId;

        const openHandler = () => {
          clearTimeout(timeoutId);
          channel.removeEventListener('open', openHandler);
          channel.removeEventListener('error', errorHandler);
          resolve();
        };

        const errorHandler = (error) => {
          clearTimeout(timeoutId);
          channel.removeEventListener('open', openHandler);
          channel.removeEventListener('error', errorHandler);
          reject(error);
        };

        channel.addEventListener('open', openHandler);
        channel.addEventListener('error', errorHandler);

        timeoutId = setTimeout(() => {
          channel.removeEventListener('open', openHandler);
          channel.removeEventListener('error', errorHandler);
          reject(new Error('Channel open timeout'));
        }, 10000);
      });
    }

    /**
      * Close peer connection
      */
    closePeerConnection() {
      // Close control channel
      if (this.controlChannel) {
        this.controlChannel.close();
        this.controlChannel = null;
      }

      // Close app channels
      for (const [, channel] of this.appChannels) {
        channel.close();
      }
      this.appChannels.clear();

      // Clean up app iframes
      for (const [, appIframe] of this.appIframes) {
        if (appIframe.parentNode) {
          appIframe.parentNode.removeChild(appIframe);
        }
      }
      this.appIframes.clear();

      // Clean up control requests
      for (const [, { reject }] of this.controlRequests) {
        reject(new Error('Client disconnected'));
      }
      this.controlRequests.clear();

      if (this.dataChannel) {
        this.dataChannel.close();
        this.dataChannel = null;
      }
      
      if (this.peerConnection) {
        this.peerConnection.close();
        this.peerConnection = null;
      }
  }
}

// ============================================================================
// Exports (works as both ES module and script tag)
// ============================================================================

// ES module exports
export { Client, verifySignature, hashChallengeAnswer };

// Browser global exports (for script tag usage)
if (typeof window !== 'undefined') {
  window.HomeChannelClient = {
    Client,
    verifySignature,
    hashChallengeAnswer
  };
}
