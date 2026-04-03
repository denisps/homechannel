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

const DEFAULT_SIGNATURE_ALGORITHM = 'ed25519';

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
      // Bundle is trusted from server (see APPS.md: trust server payloads)
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
// Binary channel framing (browser, mirrors server/webrtc.js FRAME_* constants)
// Frame format: [type:uint8][payloadLen:uint32BE][payload]
// ============================================================================
const FRAME_JSON   = 0x01; // UTF-8 JSON payload
const FRAME_CHUNK  = 0x02; // raw binary chunk
const FRAME_END    = 0x03; // end-of-stream, JSON payload: { requestId }
const FRAME_CANCEL = 0x04; // cancel, JSON payload: { requestId }

function packFrame(type, payload) {
  let bytes;
  if (payload instanceof ArrayBuffer) {
    bytes = new Uint8Array(payload);
  } else if (ArrayBuffer.isView(payload)) {
    bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  } else {
    bytes = new TextEncoder().encode(String(payload));
  }
  const frame = new ArrayBuffer(5 + bytes.byteLength);
  const view = new DataView(frame);
  view.setUint8(0, type);
  view.setUint32(1, bytes.byteLength, false); // big-endian
  new Uint8Array(frame).set(bytes, 5);
  return frame;
}

function unpackFrame(data) {
  const buf = data instanceof ArrayBuffer ? data
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (buf.byteLength < 5) throw new Error('Frame too short');
  const view = new DataView(buf);
  const type = view.getUint8(0);
  const len  = view.getUint32(1, false);
  return { type, payload: buf.slice(5, 5 + len) };
}

// HTML-escape helper for safe dynamic markup
function _hcEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// Desktop CSS (injected once)
// ============================================================================
const _HC_STYLES = `
  #hc-desktop {
    position: fixed; inset: 0;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
  }
  #hc-cov {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    z-index: 500; background: rgba(0,0,0,0.2);
  }
  .hc-card {
    background: #fff; border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    padding: 2rem; max-width: 480px; width: 90%;
  }
  .hc-card h1 { font-size: 1.5rem; color: #667eea; margin-bottom: 1.4rem; text-align: center; }
  .hc-fg { margin-bottom: 1rem; }
  .hc-fg label { display: block; margin-bottom: 0.35rem; font-weight: 500; color: #555; font-size: 0.88rem; }
  .hc-fg input, .hc-fg textarea {
    width: 100%; padding: 0.55rem 0.7rem; border: 1px solid #ddd;
    border-radius: 6px; font-size: 0.9rem; font-family: inherit;
  }
  .hc-fg input:focus, .hc-fg textarea:focus { outline: none; border-color: #667eea; }
  .hc-fg textarea { min-height: 68px; font-family: monospace; font-size: 0.78rem; resize: vertical; }
  .hc-submit {
    width: 100%; padding: 0.65rem; border: none; border-radius: 6px;
    font-size: 0.95rem; font-weight: 600; cursor: pointer;
    background: linear-gradient(135deg, #667eea, #764ba2); color: #fff; margin-top: 0.4rem;
  }
  .hc-submit:disabled { opacity: 0.5; cursor: not-allowed; }
  .hc-c-status { text-align: center; margin-top: 0.6rem; font-size: 0.85rem; color: #666; min-height: 1.1em; }
  .hc-c-status.err { color: #e55; }
  #hc-tb {
    position: absolute; bottom: 0; left: 0; right: 0; height: 44px;
    background: rgba(10,10,20,0.85); backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-top: 1px solid rgba(255,255,255,0.1);
    display: none; align-items: center; gap: 4px; padding: 0 8px; z-index: 200;
  }
  #hc-tb.hc-visible { display: flex; }
  #hc-tb-start {
    padding: 4px 12px; border: none; border-radius: 6px;
    background: rgba(102,126,234,0.7); color: #fff;
    font-size: 0.82rem; font-weight: 600; cursor: pointer; flex-shrink: 0;
  }
  #hc-tb-start:hover { background: rgba(102,126,234,0.9); }
  #hc-tb-apps { display: flex; gap: 4px; flex: 1; overflow-x: auto; min-width: 0; }
  .hc-tb-task {
    padding: 4px 12px; border: none; border-radius: 5px;
    background: rgba(255,255,255,0.12); color: #fff;
    font-size: 0.75rem; cursor: pointer; white-space: nowrap;
    max-width: 160px; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0;
  }
  .hc-tb-task.active { background: rgba(255,255,255,0.28); }
  .hc-tb-task:hover { background: rgba(255,255,255,0.2); }
  #hc-tb-disco {
    padding: 4px 10px; border: none; border-radius: 5px;
    background: rgba(220,50,50,0.5); color: #fff;
    font-size: 0.75rem; cursor: pointer; flex-shrink: 0;
  }
  #hc-tb-disco:hover { background: rgba(220,50,50,0.8); }
  .hc-win {
    position: absolute; min-width: 320px; min-height: 180px;
    background: #fff; border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.35);
    display: flex; flex-direction: column; overflow: hidden; outline: none;
  }
  .hc-win.hc-focused { box-shadow: 0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(102,126,234,0.4); }
  .hc-win.hc-minimized { display: none; }
  .hc-win.hc-maximized { border-radius: 0; }
  .hc-wtb {
    height: 34px; background: linear-gradient(90deg, #667eea, #764ba2); color: #fff;
    display: flex; align-items: center; padding: 0 6px 0 10px;
    cursor: default; user-select: none; flex-shrink: 0;
  }
  .hc-wtb-drag { display: flex; align-items: center; flex: 1; overflow: hidden; cursor: move; gap: 6px; }
  .hc-wico { font-size: 0.85rem; }
  .hc-wtitle { font-weight: 600; font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hc-wbtns { display: flex; gap: 3px; flex-shrink: 0; }
  .hc-wbtn {
    width: 22px; height: 22px; border: none; border-radius: 50%; font-size: 0.75rem;
    font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .hc-wbtn-min { background: #f6c90e; color: #555; }
  .hc-wbtn-max { background: #4caf50; color: #fff; font-size: 0.65rem; }
  .hc-wbtn-cls { background: #f44336; color: #fff; }
  .hc-wbtn:hover { opacity: 0.8; }
  .hc-wbody { flex: 1; overflow: hidden; position: relative; background: #f5f7fa; }
  .hc-wbody iframe { width: 100%; height: 100%; border: none; display: block; }
  .hc-wload {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: #667eea; font-size: 0.9rem; padding: 1rem; text-align: center;
  }
  .hc-rz { position: absolute; z-index: 10; }
  .hc-rz-n  { top: 0; left: 7px; right: 7px; height: 5px; cursor: n-resize; }
  .hc-rz-s  { bottom: 0; left: 7px; right: 7px; height: 5px; cursor: s-resize; }
  .hc-rz-e  { right: 0; top: 7px; bottom: 7px; width: 5px; cursor: e-resize; }
  .hc-rz-w  { left: 0; top: 7px; bottom: 7px; width: 5px; cursor: w-resize; }
  .hc-rz-nw { top: 0; left: 0; width: 12px; height: 12px; cursor: nw-resize; }
  .hc-rz-ne { top: 0; right: 0; width: 12px; height: 12px; cursor: ne-resize; }
  .hc-rz-sw { bottom: 0; left: 0; width: 12px; height: 12px; cursor: sw-resize; }
  .hc-rz-se { bottom: 0; right: 0; width: 12px; height: 12px; cursor: se-resize; }
  .hc-launcher-body { padding: 0.6rem; overflow-y: auto; height: 100%; }
  .hc-app-btn {
    display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 0.55rem 0.75rem; border: none; border-radius: 7px;
    background: #f0f2ff; text-align: left; cursor: pointer; margin-bottom: 6px; font-size: 0.85rem;
  }
  .hc-app-btn:hover { background: #e0e4ff; }
  .hc-app-btn .anic { font-size: 1.3rem; }
  .hc-app-btn .nfo strong { display: block; font-size: 0.88rem; }
  .hc-app-btn .nfo small { color: #888; font-size: 0.75rem; }
`;

// ============================================================================
// WindowManager — manages z-order and lifetime of all AppWindows
// ============================================================================
class WindowManager {
  constructor(desktopEl) {
    this.desktop = desktopEl;
    this.windows = [];
    this._z = 100;
  }

  createWindow(title, opts = {}) {
    const win = new AppWindow(this, title, opts);
    this.windows.push(win);
    this.desktop.appendChild(win.el);
    this.bringToFront(win);
    return win;
  }

  removeWindow(win) {
    const idx = this.windows.indexOf(win);
    if (idx >= 0) this.windows.splice(idx, 1);
    win.el.remove();
  }

  bringToFront(win) {
    this._z++;
    win.el.style.zIndex = this._z;
    this.windows.forEach(w => w.el.classList.toggle('hc-focused', w === win));
  }
}

// ============================================================================
// AppWindow — resizable, draggable, minimizable, maximizable, closable window
// ============================================================================
class AppWindow {
  constructor(mgr, title, opts = {}) {
    this.mgr   = mgr;
    this.title = title;
    this.opts  = opts;
    this.minimized    = false;
    this.maximized    = false;
    this._savedBounds = null;
    this._tbBtn  = null;
    this._iframe = null;
    this.onClose = opts.onClose || null;
    this.el = this._build();
    const w = opts.w || 900;
    const h = opts.h || 580;
    const tbH = 44; // taskbar height
    const x = opts.x ?? Math.max(10, Math.min((window.innerWidth  - w - 10), 40 + (Math.random() * 80 | 0)));
    const y = opts.y ?? Math.max(10, Math.min((window.innerHeight - h - tbH - 10), 40 + (Math.random() * 40 | 0)));
    this._setBounds(x, y, w, h);
    this._setupDrag();
    this._setupResize();
    this.el.addEventListener('mousedown', () => this.mgr.bringToFront(this));
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'hc-win';
    el.tabIndex  = -1;
    el.innerHTML =
      '<div class="hc-rz hc-rz-n" data-dir="n"></div>' +
      '<div class="hc-rz hc-rz-s" data-dir="s"></div>' +
      '<div class="hc-rz hc-rz-e" data-dir="e"></div>' +
      '<div class="hc-rz hc-rz-w" data-dir="w"></div>' +
      '<div class="hc-rz hc-rz-nw" data-dir="nw"></div>' +
      '<div class="hc-rz hc-rz-ne" data-dir="ne"></div>' +
      '<div class="hc-rz hc-rz-sw" data-dir="sw"></div>' +
      '<div class="hc-rz hc-rz-se" data-dir="se"></div>' +
      '<div class="hc-wtb">' +
      '  <div class="hc-wtb-drag">' +
      `    <span class="hc-wico">${_hcEsc(this.opts.icon || '⚙️')}</span>` +
      `    <span class="hc-wtitle">${_hcEsc(this.title)}</span>` +
      '  </div>' +
      '  <div class="hc-wbtns">' +
      '    <button class="hc-wbtn hc-wbtn-min" title="Minimize">&#x2013;</button>' +
      '    <button class="hc-wbtn hc-wbtn-max" title="Maximize/Restore">&#x25a1;</button>' +
      '    <button class="hc-wbtn hc-wbtn-cls" title="Close">&times;</button>' +
      '  </div>' +
      '</div>' +
      '<div class="hc-wbody"><div class="hc-wload">Loading\u2026</div></div>';
    el.querySelector('.hc-wbtn-min').addEventListener('click', e => { e.stopPropagation(); this.minimize(); });
    el.querySelector('.hc-wbtn-max').addEventListener('click', e => { e.stopPropagation(); this.maximize(); });
    el.querySelector('.hc-wbtn-cls').addEventListener('click', e => { e.stopPropagation(); this.close(); });
    return el;
  }

  showLoading(msg = 'Loading\u2026') {
    this.el.querySelector('.hc-wbody').innerHTML = `<div class="hc-wload">${_hcEsc(msg)}</div>`;
  }

  showError(msg) {
    this.el.querySelector('.hc-wbody').innerHTML =
      `<div class="hc-wload" style="color:#e55;flex-direction:column;gap:.5rem">` +
      `<span>&#x274C;</span><span>${_hcEsc(msg)}</span></div>`;
  }

  _setBounds(left, top, width, height) {
    const s = this.el.style;
    s.left   = `${Math.round(left)}px`;
    s.top    = `${Math.round(top)}px`;
    s.width  = `${Math.max(320,  Math.round(width))}px`;
    s.height = `${Math.max(180, Math.round(height))}px`;
  }

  _getBounds() {
    const s = this.el.style;
    return {
      left:   parseInt(s.left)   || 0,
      top:    parseInt(s.top)    || 0,
      width:  parseInt(s.width)  || 900,
      height: parseInt(s.height) || 580
    };
  }

  minimize() {
    if (this.minimized) return;
    this.minimized = true;
    this.el.classList.add('hc-minimized');
    this._tbBtn?.classList.remove('active');
  }

  restore() {
    if (!this.minimized) return;
    this.minimized = false;
    this.el.classList.remove('hc-minimized');
    this.mgr.bringToFront(this);
    this._tbBtn?.classList.add('active');
  }

  maximize() {
    if (this.maximized) {
      if (this._savedBounds) {
        const b = this._savedBounds;
        this._setBounds(b.left, b.top, b.width, b.height);
      }
      this.maximized = false;
      this.el.classList.remove('hc-maximized');
      this.el.querySelector('.hc-wbtn-max').innerHTML = '&#x25a1;';
    } else {
      this._savedBounds = this._getBounds();
      const tb = document.getElementById('hc-tb');
      const tbH = tb ? tb.offsetHeight : 44;
      this._setBounds(0, 0, this.mgr.desktop.clientWidth, this.mgr.desktop.clientHeight - tbH);
      this.maximized = true;
      this.el.classList.add('hc-maximized');
      this.el.querySelector('.hc-wbtn-max').innerHTML = '&#x274f;';
    }
  }

  close() {
    if (typeof this.onClose === 'function') this.onClose();
    this.mgr.removeWindow(this);
  }

  _setupDrag() {
    const handle = this.el.querySelector('.hc-wtb-drag');
    handle.addEventListener('mousedown', e => {
      if (this.maximized) return;
      e.preventDefault();
      this.mgr.bringToFront(this);
      const { left: startL, top: startT } = this._getBounds();
      const startX = e.clientX, startY = e.clientY;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;cursor:move';
      document.body.appendChild(overlay);
      const onMove = me => {
        this._setBounds(startL + me.clientX - startX, startT + me.clientY - startY,
          parseInt(this.el.style.width), parseInt(this.el.style.height));
      };
      const onUp = () => {
        overlay.remove();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    handle.addEventListener('dblclick', () => this.maximize());
  }

  _setupResize() {
    this.el.querySelectorAll('.hc-rz').forEach(rz => {
      rz.addEventListener('mousedown', e => {
        if (this.maximized) return;
        e.preventDefault();
        e.stopPropagation();
        this.mgr.bringToFront(this);
        const dir = rz.dataset.dir;
        const sb  = this._getBounds();
        const sx  = e.clientX, sy = e.clientY;
        const overlay = document.createElement('div');
        overlay.style.cssText = `position:fixed;inset:0;z-index:99999;cursor:${dir}-resize`;
        document.body.appendChild(overlay);
        const onMove = me => {
          const dx = me.clientX - sx, dy = me.clientY - sy;
          let { left, top, width, height } = sb;
          if (dir.includes('e')) width  = Math.max(320, width  + dx);
          if (dir.includes('s')) height = Math.max(180, height + dy);
          if (dir.includes('w')) { left += dx; width  = Math.max(320, width  - dx); }
          if (dir.includes('n')) { top  += dy; height = Math.max(180, height - dy); }
          this._setBounds(left, top, width, height);
        };
        const onUp = () => {
          overlay.remove();
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }
}

// ============================================================================
// AppManager — desktop UI, connection management, app launching, message bridge
// ============================================================================
class AppManager {
  constructor(rootEl) {
    this.root     = rootEl;
    this.client   = null;
    this.wm       = null;
    this._appList = [];
    this._launcherWin = null;
  }

  init() {
    if (!document.getElementById('hc-mgr-styles')) {
      const s = document.createElement('style');
      s.id = 'hc-mgr-styles';
      s.textContent = _HC_STYLES;
      document.head.appendChild(s);
    }
    this._buildDesktop();
  }

  _buildDesktop() {
    const desktop = document.createElement('div');
    desktop.id = 'hc-desktop';
    desktop.innerHTML = `
      <div id="hc-cov">
        <div class="hc-card">
          <h1>🏠 HomeChannel</h1>
          <form id="hc-cform" autocomplete="on">
            <div class="hc-fg">
              <label for="hc-url">Coordinator URL</label>
              <input id="hc-url" type="url" name="hc-url" placeholder="https://coordinator.example.com" required />
            </div>
            <div class="hc-fg">
              <label for="hc-key">Server Public Key</label>
              <textarea id="hc-key" name="hc-key" placeholder="Paste PEM or base64 public key" rows="3" required></textarea>
            </div>
            <div class="hc-fg">
              <label for="hc-pass">Password</label>
              <input id="hc-pass" type="password" name="hc-pass" placeholder="Enter password" required />
            </div>
            <button class="hc-submit" id="hc-cbtn" type="submit">Connect</button>
            <p class="hc-c-status" id="hc-cstat"></p>
          </form>
        </div>
      </div>
      <div id="hc-tb">
        <button id="hc-tb-start">📦 Apps</button>
        <div id="hc-tb-apps"></div>
        <button id="hc-tb-disco">Disconnect</button>
      </div>
    `;
    this.root.innerHTML = '';
    this.root.appendChild(desktop);
    this.wm = new WindowManager(desktop);

    // Restore saved values
    try {
      const u = localStorage.getItem('hc_url');
      const k = localStorage.getItem('hc_key');
      const p = localStorage.getItem('hc_pass');
      if (u) desktop.querySelector('#hc-url').value = u;
      if (k) desktop.querySelector('#hc-key').value = k;
      if (p) desktop.querySelector('#hc-pass').value = p;
    } catch (_) {}

    // URL-embedded server key
    try {
      const ep = new URLSearchParams(location.search).get('serverKey');
      if (ep) desktop.querySelector('#hc-key').value = decodeURIComponent(ep);
    } catch (_) {}

    desktop.querySelector('#hc-cform').addEventListener('submit', async e => {
      e.preventDefault();
      const url  = desktop.querySelector('#hc-url').value.trim();
      const key  = desktop.querySelector('#hc-key').value.trim();
      const pass = desktop.querySelector('#hc-pass').value;
      try {
        localStorage.setItem('hc_url', url);
        localStorage.setItem('hc_key', key);
        localStorage.setItem('hc_pass', pass);
      } catch (_) {}
      await this._doConnect(url, key, pass);
    });

    desktop.querySelector('#hc-tb-start').addEventListener('click',  () => this._openLauncher());
    desktop.querySelector('#hc-tb-disco').addEventListener('click',  () => this._doDisconnect());
  }

  _setStatus(msg, isErr = false) {
    const el = document.getElementById('hc-cstat');
    if (!el) return;
    el.textContent = msg;
    el.className = 'hc-c-status' + (isErr ? ' err' : '');
  }

  async _doConnect(url, key, pass) {
    const btn = document.getElementById('hc-cbtn');
    if (btn) btn.disabled = true;
    this._setStatus('Connecting\u2026');
    try {
      this.client = new Client(url);
      this.client.on('error',        err  => this._setStatus(err.message || 'Error', true));
      this.client.on('disconnected', ()   => this._onDisconnected());
      await this.client.connect(key, pass);
      this._setStatus('');
      await this._onConnected();
    } catch (err) {
      this._setStatus(err.message || 'Connection failed', true);
      if (btn) btn.disabled = false;
    }
  }

  async _onConnected() {
    document.getElementById('hc-cov').style.display = 'none';
    document.getElementById('hc-tb').classList.add('hc-visible');
    try {
      this._appList = await this.client.requestAppList();
    } catch (_) {
      this._appList = [];
    }
    this._openLauncher();
  }

  _onDisconnected() {
    this._appList = [];
    document.getElementById('hc-tb')?.classList.remove('hc-visible');
    const cov = document.getElementById('hc-cov');
    if (cov) cov.style.display = '';
    const btn = document.getElementById('hc-cbtn');
    if (btn) btn.disabled = false;
    this._setStatus('Disconnected');
    [...(this.wm?.windows || [])].forEach(w => w.mgr.removeWindow(w));
    this._launcherWin = null;
  }

  _doDisconnect() {
    try { this.client?.disconnect?.(); } catch (_) {}
    this._onDisconnected();
  }

  _openLauncher() {
    if (this._launcherWin && this.wm.windows.includes(this._launcherWin)) {
      if (this._launcherWin.minimized) this._launcherWin.restore();
      else this.wm.bringToFront(this._launcherWin);
      return;
    }
    const win = this.wm.createWindow('App Launcher', { icon: '📦', w: 340, h: 400 });
    this._launcherWin = win;
    win.onClose = () => { this._launcherWin = null; };
    const apps = this._appList;
    if (!apps || apps.length === 0) {
      win.showError('No apps available');
      return;
    }
    const inner = document.createElement('div');
    inner.className = 'hc-launcher-body';
    for (const app of apps) {
      const btn = document.createElement('button');
      btn.className = 'hc-app-btn';
      btn.innerHTML =
        `<span class="anic">📁</span>` +
        `<span class="nfo"><strong>${_hcEsc(app.name)}</strong>` +
        `<small>v${_hcEsc(String(app.version || '1.0'))}</small></span>`;
      btn.addEventListener('click', () => this.launchApp(app.name));
      inner.appendChild(btn);
    }
    win.el.querySelector('.hc-wbody').innerHTML = '';
    win.el.querySelector('.hc-wbody').appendChild(inner);
    this._addTaskbarBtn(win, `📦 Launcher`);
  }

  async launchApp(appName) {
    const win = this.wm.createWindow(appName, { icon: '📁', w: 960, h: 620 });
    win.showLoading(`Opening ${appName}\u2026`);
    this._addTaskbarBtn(win, `📁 ${appName}`);
    try {
      const channel = await this.client.openAppChannel(appName);
      this._setupAppBridge(win, channel, appName);
    } catch (err) {
      win.showError(`Failed to open ${appName}: ${err.message}`);
    }
  }

  _addTaskbarBtn(win, label) {
    const tb = document.getElementById('hc-tb-apps');
    if (!tb) return;
    const btn = document.createElement('button');
    btn.className = 'hc-tb-task active';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (win.minimized) win.restore();
      else if (win.el.classList.contains('hc-focused')) win.minimize();
      else this.wm.bringToFront(win);
    });
    tb.appendChild(btn);
    win._tbBtn = btn;
    win.el.addEventListener('mousedown', () => {
      tb.querySelectorAll('.hc-tb-task').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    // Remove taskbar button when window is closed
    const origClose = win.onClose;
    win.onClose = () => { btn.remove(); if (origClose) origClose(); };
  }

  /**
   * Wire a DataChannel to a window's iframe via postMessage bridge.
   * Binary protocol: FRAME_JSON for RPC, FRAME_CHUNK for file data, FRAME_END for end.
   * Downloads are triggered in the parent frame (sandboxed iframe cannot trigger downloads).
   */
  _setupAppBridge(win, channel, appName) {
    let activeDL = null;  // active streaming download state
    const uploads = new Map();  // requestId → true, track pending uploads
    let _nextId = 0;
    const dec = new TextDecoder();

    // ── Outbound: iframe → datachannel ────────────────────────────────────────
    const bridgeOut = evt => {
      if (!evt.data || evt.source !== win._iframe?.contentWindow) return;
      const msg = evt.data;
      switch (msg.type) {
        case 'channel:send':
          if (typeof msg.data === 'string') {
            try { channel.send(packFrame(FRAME_JSON, msg.data)); } catch (_) {}
          }
          break;
        case 'channel:download': {
          const reqId = `dl_${++_nextId}`;
          activeDL = {
            requestId: reqId,
            name: String(msg.name || 'download'),
            mimeType: 'application/octet-stream',
            size: 0, chunks: [], received: 0
          };
          try {
            channel.send(packFrame(FRAME_JSON, JSON.stringify({
              requestId: reqId, operation: 'readFile', params: { path: msg.path }
            })));
          } catch (_) {}
          break;
        }
        case 'channel:upload:start':
          uploads.set(msg.requestId, true);
          try {
            channel.send(packFrame(FRAME_JSON, JSON.stringify({
              requestId: msg.requestId, operation: 'writeFile',
              params: { path: msg.path, size: msg.size }
            })));
          } catch (_) {}
          break;
        case 'channel:chunk':
          if (msg.buffer instanceof ArrayBuffer) {
            try { channel.send(packFrame(FRAME_CHUNK, msg.buffer)); } catch (_) {}
          }
          break;
        case 'channel:upload:end':
          uploads.delete(msg.requestId);
          try { channel.send(packFrame(FRAME_END, JSON.stringify({ requestId: msg.requestId }))); } catch (_) {}
          break;
        case 'channel:cancel':
          uploads.delete(msg.requestId);
          try { channel.send(packFrame(FRAME_CANCEL, JSON.stringify({ requestId: msg.requestId }))); } catch (_) {}
          break;
      }
    };
    window.addEventListener('message', bridgeOut);

    // Set up close handler before bundle arrives (will be wrapped by _addTaskbarBtn)
    const origClose = win.onClose;
    win.onClose = () => {
      win._iframe = null;
      window.removeEventListener('message', bridgeOut);
      try { channel.close(); } catch (_) {}
      if (origClose) origClose();
    };

    channel.onclose = () => { window.removeEventListener('message', bridgeOut); };

    // ── Inbound: datachannel → iframe / parent frame ──────────────────────────
    channel.onmessage = event => {
      const rawData = event.data;
      const iframeWin = win._iframe?.contentWindow;

      // Handle plain string (old protocol fallback)
      if (typeof rawData === 'string') {
        try {
          const parsed = JSON.parse(rawData);
          if (parsed.type === 'app:bundle' && parsed.bundle) {
            this._loadBundle(win, appName, parsed.bundle);
          } else if (iframeWin) {
            iframeWin.postMessage({ type: 'channel:message', data: rawData }, '*');
          }
        } catch (_) {}
        return;
      }

      // Binary frame
      let ft, payload;
      try {
        const ab = rawData instanceof ArrayBuffer ? rawData
          : (ArrayBuffer.isView(rawData)
             ? rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength)
             : null);
        if (!ab) return;
        ({ type: ft, payload } = unpackFrame(ab));
      } catch (_) { return; }

      if (ft === FRAME_JSON) {
        const text = dec.decode(payload);
        let msg;
        try { msg = JSON.parse(text); } catch { return; }

        if (msg.type === 'app:bundle' && msg.bundle) {
          this._loadBundle(win, appName, msg.bundle);
        } else if (activeDL && msg.requestId === activeDL.requestId && msg.streaming) {
          activeDL.size     = msg.result?.size ?? 0;
          activeDL.mimeType = msg.result?.mimeType ?? 'application/octet-stream';
          iframeWin?.postMessage({ type: 'download:progress', name: activeDL.name, received: 0, total: activeDL.size }, '*');
        } else if (iframeWin) {
          iframeWin.postMessage({ type: 'channel:message', data: text }, '*');
        }
      } else if (ft === FRAME_CHUNK && activeDL) {
        activeDL.chunks.push(payload.slice(0));
        activeDL.received += payload.byteLength;
        iframeWin?.postMessage({ type: 'download:progress', name: activeDL.name, received: activeDL.received, total: activeDL.size }, '*');
      } else if (ft === FRAME_END) {
        let endMeta = {};
        try { endMeta = JSON.parse(dec.decode(payload)); } catch (_) {}
        if (activeDL && (!endMeta.requestId || endMeta.requestId === activeDL.requestId)) {
          const dl = activeDL;
          activeDL = null;
          // Assemble full file and trigger download from parent frame (bypasses sandbox restriction)
          const total = dl.chunks.reduce((s, c) => s + c.byteLength, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const chunk of dl.chunks) { out.set(new Uint8Array(chunk), off); off += chunk.byteLength; }
          const blob = new Blob([out], { type: dl.mimeType });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href = url; a.download = dl.name;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 3000);
          iframeWin?.postMessage({ type: 'download:done', name: dl.name }, '*');
        }
      }
    };
  }

  /** Load the app bundle into the window body */
  _loadBundle(win, appName, bundle) {
    win.el.querySelector('.hc-wbody').innerHTML = '';
    const iframe = this.client.loadAppInSandbox(appName, bundle, win.el.querySelector('.hc-wbody'));
    win._iframe = iframe;
  }
}

// ============================================================================
// Exports (works as both ES module and script tag)
// ============================================================================

// Expose via globalThis - works in browser (classic script or module) and Node.js
// Using globalThis avoids the 'export' keyword which is a SyntaxError in classic scripts
globalThis.HomeChannelClient = { Client, AppManager, verifySignature, hashChallengeAnswer };
