/**
 * WebRTC connection handler for server
 * Provides W3C-compliant abstractions for multiple WebRTC libraries
 * Supports: werift, wrtc (node-webrtc), node-datachannel
 */
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Timeout for node-datachannel local description generation (ms)
const NODE_DATACHANNEL_TIMEOUT_MS = 5000;

// Supported WebRTC libraries
const SUPPORTED_LIBRARIES = ['werift', 'wrtc', 'node-datachannel'];

/**
 * Check which WebRTC libraries are available
 * @returns {Promise<{available: string[], missing: string[]}>}
 */
export async function checkWebRTCLibraries() {
  const available = [];
  const missing = [];

  for (const libraryName of SUPPORTED_LIBRARIES) {
    const library = await loadWebRTCLibrary(libraryName, true);
    if (library) {
      available.push(libraryName);
    } else {
      missing.push(libraryName);
    }
  }

  return { available, missing };
}

/**
 * Display WebRTC library status and prompt for missing libraries
 * @returns {Promise<void>}
 */
export async function displayWebRTCStatus() {
  const { available, missing } = await checkWebRTCLibraries();

  if (available.length > 0) {
    console.log(`\n✓ WebRTC libraries installed: ${available.join(', ')}`);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  WebRTC libraries not installed: ${missing.join(', ')}`);
    console.log('   Install with: npm install ' + missing.join(' '));
    console.log('   Note: These are optional - you only need one WebRTC library.\n');
  } else {
    console.log('');
  }
}

/**
 * Load WebRTC library dynamically
 * @param {string} libraryName - Name of the library to load (werift, wrtc, node-datachannel)
 * @param {boolean} silent - If true, suppress warning messages
 * @returns {Promise<object>} Loaded library module
 */
export async function loadWebRTCLibrary(libraryName = 'werift', silent = false) {
  try {
    const module = await import(libraryName);
    return module;
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      if (!silent) {
        console.warn(`\n⚠️  WebRTC library '${libraryName}' is not installed.`);
        console.warn(`   Install it with: npm install ${libraryName}\n`);
      }
      return null;
    }
    throw error;
  }
}

/**
 * W3C-compliant WebRTC peer connection abstraction
 * Normalizes different Node.js WebRTC libraries to match browser API
 */
export class WebRTCPeer {
  constructor(library, libraryName = 'werift', options = {}) {
    this.library = library;
    this.libraryName = libraryName;
    this.pc = null;
    this.dataChannels = new Map(); // label -> channel (support multiple channels)
    this.iceCandidates = [];
    this.handlers = new Map();
    this.options = options;
    this.serviceRouter = options.serviceRouter || null;
    this.localDescription = null; // Store local description for node-datachannel
    this.localDescriptionPromise = null; // Promise for waiting on local description
  }

  /**
   * Initialize peer connection
   */
  async init(config = {}) {
    if (!this.library) {
      throw new Error('WebRTC library not loaded');
    }

    const iceServers = config.iceServers || [];

    switch (this.libraryName) {
      case 'werift':
        this.pc = await this._initWerift(iceServers);
        break;
      case 'wrtc':
        this.pc = await this._initWrtc(iceServers);
        break;
      case 'node-datachannel':
        this.pc = await this._initNodeDatachannel(iceServers);
        break;
      default:
        throw new Error(`Unknown WebRTC library: ${this.libraryName}`);
    }

    this._setupEventHandlers();
  }

  /**
   * Initialize werift library
   */
  async _initWerift(iceServers) {
    const { RTCPeerConnection } = this.library;
    const pc = new RTCPeerConnection({
      iceServers: iceServers.map(server => ({
        urls: server.urls,
        username: server.username,
        credential: server.credential
      }))
    });
    return pc;
  }

  /**
   * Initialize wrtc (node-webrtc) library
   */
  async _initWrtc(iceServers) {
    const { RTCPeerConnection } = this.library;
    const pc = new RTCPeerConnection({
      iceServers: iceServers.map(server => ({
        urls: server.urls,
        username: server.username,
        credential: server.credential
      }))
    });
    return pc;
  }

  /**
   * Initialize node-datachannel library
   */
  async _initNodeDatachannel(iceServers) {
    const { PeerConnection } = this.library;
    const config = {
      iceServers: iceServers.map(server => server.urls).flat()
    };
    const pc = new PeerConnection('server', config);
    return pc;
  }

  /**
   * Setup event handlers based on library
   */
  _setupEventHandlers() {
    if (!this.pc) return;

    switch (this.libraryName) {
      case 'werift':
      case 'wrtc':
        this._setupW3CHandlers();
        break;
      case 'node-datachannel':
        this._setupNodeDatachannelHandlers();
        break;
    }
  }

  /**
   * Setup W3C-compliant handlers (werift, wrtc)
   */
  _setupW3CHandlers() {
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.iceCandidates.push(event.candidate);
        if (this.handlers.has('icecandidate')) {
          this.handlers.get('icecandidate')(event.candidate);
        }
      }
    };

    this.pc.ondatachannel = (event) => {
      const dc = event.channel || event.datachannel;
      const label = dc.label || 'default';
      this.dataChannels.set(label, dc);
      
      // Route based on channel label
      if (label === 'apps-control') {
        this._setupControlChannelHandlers(dc);
      } else if (this.serviceRouter && this.serviceRouter.apps.has(label)) {
        this._setupAppChannelHandlers(dc, label);
      } else {
        // Legacy single-channel mode
        this._setupLegacyDataChannelHandlers(dc);
      }
      
      if (this.handlers.has('datachannel')) {
        this.handlers.get('datachannel')(dc);
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.handlers.has('connectionstatechange')) {
        this.handlers.get('connectionstatechange')(this.pc.connectionState);
      }
    };
  }

  /**
   * Setup node-datachannel handlers
   */
  _setupNodeDatachannelHandlers() {
    // Create a promise that will resolve when local description is available
    this.resetLocalDescriptionPromise();

    this.pc.onLocalDescription((description, type) => {
      // Store local description
      this.localDescription = { sdp: description, type };
      if (this._localDescriptionResolve) {
        const resolve = this._localDescriptionResolve;
        // Clean up resolver references after calling
        this._localDescriptionResolve = null;
        this._localDescriptionReject = null;
        resolve({ sdp: description, type });
      }
    });

    this.pc.onLocalCandidate((candidate, mid) => {
      const iceCandidate = {
        candidate,
        sdpMid: mid,
        sdpMLineIndex: 0
      };
      this.iceCandidates.push(iceCandidate);
      if (this.handlers.has('icecandidate')) {
        this.handlers.get('icecandidate')(iceCandidate);
      }
    });

    this.pc.onDataChannel((dc) => {
      const label = dc.getLabel() || 'default';
      this.dataChannels.set(label, dc);
      
      // Route based on channel label
      if (label === 'apps-control') {
        this._setupControlChannelHandlersNodeDC(dc);
      } else if (this.serviceRouter && this.serviceRouter.apps.has(label)) {
        this._setupAppChannelHandlersNodeDC(dc, label);
      } else {
        // Legacy single-channel mode
        this._setupNodeDatachannelDataChannel(dc);
      }
      
      if (this.handlers.has('datachannel')) {
        this.handlers.get('datachannel')(dc);
      }
    });

    this.pc.onStateChange((state) => {
      if (this.handlers.has('connectionstatechange')) {
        this.handlers.get('connectionstatechange')(state);
      }
    });
  }

  /**
   * Reset the local description promise for node-datachannel
   * Call this before operations that will generate a new local description
   * (e.g., before creating a datachannel for offer, or before setRemoteDescription for answer)
   */
  resetLocalDescriptionPromise() {
    if (this.libraryName !== 'node-datachannel') {
      return; // No-op for other libraries
    }
    
    // Clean up previous resolver references to ensure garbage collection
    this._localDescriptionResolve = null;
    this._localDescriptionReject = null;
    
    // Create new promise - previous promise (if any) will remain unresolved
    // Callers should not retain references to old promises
    this.localDescriptionPromise = new Promise((resolve, reject) => {
      this._localDescriptionResolve = resolve;
      this._localDescriptionReject = reject;
    });
  }

  /**
   * Setup datachannel handlers for W3C libraries (legacy mode)
   */
  _setupLegacyDataChannelHandlers(dc) {
    dc.onmessage = (event) => {
      if (this.handlers.has('message')) {
        this.handlers.get('message')(event.data);
      }
    };

    dc.onopen = () => {
      if (this.handlers.has('open')) {
        this.handlers.get('open')();
      }
    };

    dc.onclose = () => {
      if (this.handlers.has('close')) {
        this.handlers.get('close')();
      }
    };

    dc.onerror = (error) => {
      if (this.handlers.has('error')) {
        this.handlers.get('error')(error);
      }
    };
  }

  /**
   * Setup control channel handlers (W3C)
   */
  _setupControlChannelHandlers(dc) {
    dc.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        const response = await this.serviceRouter.handleControlMessage(message);
        dc.send(JSON.stringify(response));
      } catch (error) {
        const errorResponse = {
          type: 'error',
          requestId: null,
          error: error.message || 'Control message error'
        };
        dc.send(JSON.stringify(errorResponse));
      }
    };

    dc.onopen = () => {
      // Control channel ready
    };

    dc.onclose = () => {
      // Control channel closed
    };

    dc.onerror = (error) => {
      console.error('Control channel error:', error);
    };
  }

  /**
   * Setup app channel handlers (W3C)
   * Sends bundle on open, then handles app messages
   */
  _setupAppChannelHandlers(dc, appName) {
    dc.onopen = async () => {
      // Send app bundle when channel opens
      await this._sendAppBundle(dc, appName);
    };

    dc.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        const response = await this.serviceRouter.handleAppMessage(appName, message);
        dc.send(JSON.stringify(response));
      } catch (error) {
        const errorResponse = {
          requestId: null,
          success: false,
          error: error.message || 'App message error'
        };
        dc.send(JSON.stringify(errorResponse));
      }
    };

    dc.onclose = () => {
      // App channel closed
    };

    dc.onerror = (error) => {
      console.error(`App channel error [${appName}]:`, error);
    };
  }

  /**
   * Setup datachannel handlers for node-datachannel
   */
  _setupNodeDatachannelDataChannel(dc) {
    dc.onMessage((msg) => {
      if (this.handlers.has('message')) {
        this.handlers.get('message')(msg);
      }
    });

    dc.onOpen(() => {
      if (this.handlers.has('open')) {
        this.handlers.get('open')();
      }
    });

    dc.onClosed(() => {
      if (this.handlers.has('close')) {
        this.handlers.get('close')();
      }
    });

    dc.onError((error) => {
      if (this.handlers.has('error')) {
        this.handlers.get('error')(error);
      }
    });
  }

  /**
   * Setup control channel handlers (node-datachannel)
   */
  _setupControlChannelHandlersNodeDC(dc) {
    dc.onMessage(async (msg) => {
      try {
        const message = JSON.parse(msg);
        const response = await this.serviceRouter.handleControlMessage(message);
        dc.sendMessage(JSON.stringify(response));
      } catch (error) {
        const errorResponse = {
          type: 'error',
          requestId: null,
          error: error.message || 'Control message error'
        };
        dc.sendMessage(JSON.stringify(errorResponse));
      }
    });

    dc.onOpen(() => {
      // Control channel ready
    });

    dc.onClosed(() => {
      // Control channel closed
    });

    dc.onError((error) => {
      console.error('Control channel error:', error);
    });
  }

  /**
   * Setup app channel handlers (node-datachannel)
   */
  _setupAppChannelHandlersNodeDC(dc, appName) {
    dc.onOpen(async () => {
      // Send app bundle when channel opens
      await this._sendAppBundleNodeDC(dc, appName);
    });

    dc.onMessage(async (msg) => {
      try {
        const message = JSON.parse(msg);
        const response = await this.serviceRouter.handleAppMessage(appName, message);
        dc.sendMessage(JSON.stringify(response));
      } catch (error) {
        const errorResponse = {
          requestId: null,
          success: false,
          error: error.message || 'App message error'
        };
        dc.sendMessage(JSON.stringify(errorResponse));
      }
    });

    dc.onClosed(() => {
      // App channel closed
    });

    dc.onError((error) => {
      console.error(`App channel error [${appName}]:`, error);
    });
  }

  /**
   * Load app UI bundle from filesystem
   * @param {string} appName - Name of the app
   * @param {object} manifest - App manifest
   * @returns {Promise<string>} UI bundle content
   */
  async _loadAppUIBundle(appName, manifest) {
    if (!manifest.ui) {
      throw new Error(`App manifest does not specify UI file: ${appName}`);
    }

    const uiPath = path.join(__dirname, 'node_modules', appName, manifest.ui);
    
    try {
      const bundle = await fsPromises.readFile(uiPath, 'utf8');
      return bundle;
    } catch (error) {
      throw new Error(`Failed to read UI bundle: ${error.message}`);
    }
  }

  /**
   * Send app bundle over datachannel (W3C)
   */
  async _sendAppBundle(dc, appName) {
    try {
      const app = this.serviceRouter.apps.get(appName);
      if (!app || !app.manifest) {
        throw new Error(`App not found: ${appName}`);
      }

      // Send header with metadata
      const header = {
        type: 'app:bundle',
        name: app.manifest.name,
        version: app.manifest.version,
        format: app.manifest.format || 'es-module',
        entry: app.manifest.entry,
        ui: app.manifest.ui || null
      };

      dc.send(JSON.stringify(header));
      
      // Load and send UI bundle if specified
      if (app.manifest.ui) {
        const bundle = await this._loadAppUIBundle(appName, app.manifest);
        dc.send(bundle);
      }
    } catch (error) {
      console.error(`Failed to send app bundle [${appName}]:`, error);
      const errorMsg = {
        type: 'error',
        error: error.message || 'Failed to load app bundle'
      };
      dc.send(JSON.stringify(errorMsg));
    }
  }

  /**
   * Send app bundle over datachannel (node-datachannel)
   */
  async _sendAppBundleNodeDC(dc, appName) {
    try {
      const app = this.serviceRouter.apps.get(appName);
      if (!app || !app.manifest) {
        throw new Error(`App not found: ${appName}`);
      }

      // Send header with metadata
      const header = {
        type: 'app:bundle',
        name: app.manifest.name,
        version: app.manifest.version,
        format: app.manifest.format || 'es-module',
        entry: app.manifest.entry,
        ui: app.manifest.ui || null
      };

      dc.sendMessage(JSON.stringify(header));
      
      // Load and send UI bundle if specified
      if (app.manifest.ui) {
        const bundle = await this._loadAppUIBundle(appName, app.manifest);
        dc.sendMessage(bundle);
      }
    } catch (error) {
      console.error(`Failed to send app bundle [${appName}]:`, error);
      const errorMsg = {
        type: 'error',
        error: error.message || 'Failed to load app bundle'
      };
      dc.sendMessage(JSON.stringify(errorMsg));
    }
  }

  /**
   * Handle incoming SDP offer from client
   */
  async handleOffer(sdpOffer) {
    try {
      if (!this.pc) {
        throw new Error('Peer connection not initialized');
      }

      const offer = typeof sdpOffer === 'string' 
        ? { type: 'offer', sdp: sdpOffer }
        : sdpOffer;

      if (this.libraryName === 'node-datachannel') {
        // Reset promise before setting remote description, which will trigger local description generation
        this.resetLocalDescriptionPromise();
        this.pc.setRemoteDescription(offer.sdp, offer.type);
      } else {
        await this.pc.setRemoteDescription(offer);
      }
    } catch (error) {
      console.error('Error handling offer:', error.message);
      throw error;
    }
  }

  /**
   * Create SDP answer
   */
  async createAnswer() {
    try {
      if (!this.pc) {
        throw new Error('Peer connection not initialized');
      }

      if (this.libraryName === 'node-datachannel') {
        // node-datachannel generates answer automatically after setRemoteDescription
        // Wait for the local description promise to resolve with timeout
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Timeout creating answer')), NODE_DATACHANNEL_TIMEOUT_MS);
        });

        try {
          const result = await Promise.race([
            this.localDescriptionPromise,
            timeoutPromise
          ]);
          clearTimeout(timeoutId);
          return result;
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      } else {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        return answer;
      }
    } catch (error) {
      console.error('Error creating answer:', error.message);
      throw error;
    }
  }

  /**
   * Wait for local description with timeout (for node-datachannel)
   * @param {number} timeoutMs - Timeout in milliseconds (default NODE_DATACHANNEL_TIMEOUT_MS)
   * @returns {Promise<object>} Local description
   */
  async waitForLocalDescription(timeoutMs = NODE_DATACHANNEL_TIMEOUT_MS) {
    if (this.libraryName !== 'node-datachannel') {
      throw new Error('waitForLocalDescription is only for node-datachannel');
    }

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Timeout waiting for local description')), timeoutMs);
    });

    try {
      const result = await Promise.race([
        this.localDescriptionPromise,
        timeoutPromise
      ]);
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Add ICE candidate
   */
  async addICECandidate(candidate) {
    try {
      if (!this.pc) {
        throw new Error('Peer connection not initialized');
      }

      if (this.libraryName === 'node-datachannel') {
        this.pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid || '0');
      } else {
        await this.pc.addIceCandidate(candidate);
      }
    } catch (error) {
      console.error('Error adding ICE candidate:', error.message);
      throw error;
    }
  }

  /**
   * Register event handler
   */
  on(event, handler) {
    this.handlers.set(event, handler);
  }

  /**
   * Send data through datachannel
   * @param {string} data - Data to send
   * @param {string} label - Channel label (defaults to first available channel)
   */
  send(data, label = null) {
    const dc = label ? this.dataChannels.get(label) : this.dataChannels.values().next().value;
    
    if (!dc) {
      throw new Error('Data channel not available');
    }

    if (this.libraryName === 'node-datachannel') {
      dc.sendMessage(data);
    } else {
      dc.send(data);
    }
  }

  /**
   * Get gathered ICE candidates
   */
  getICECandidates() {
    return this.iceCandidates;
  }

  /**
   * Handle incoming message from datachannel
   */
  async handleDataChannelMessage(message) {
    let parsedMessage;
    
    try {
      parsedMessage = typeof message === 'string' ? JSON.parse(message) : message;
    } catch (error) {
      return {
        requestId: null,
        success: false,
        error: 'Invalid JSON format'
      };
    }

    if (!this.serviceRouter) {
      return {
        requestId: parsedMessage.requestId,
        success: false,
        error: 'Service router not configured'
      };
    }

    try {
      const response = await this.serviceRouter.handleMessage(parsedMessage);
      return response;
    } catch (error) {
      return {
        requestId: parsedMessage.requestId || null,
        success: false,
        error: 'Internal server error'
      };
    }
  }

  /**
   * Send message over datachannel
   * @param {object} message - Message object to serialize and send
   * @param {string} label - Channel label (defaults to first available channel)
   */
  sendMessage(message, label = null) {
    const dc = label ? this.dataChannels.get(label) : this.dataChannels.values().next().value;
    
    if (!dc || dc.readyState !== 'open') {
      throw new Error('DataChannel not ready');
    }
    
    const json = JSON.stringify(message);
    if (this.libraryName === 'node-datachannel') {
      dc.sendMessage(json);
    } else {
      dc.send(json);
    }
  }

  /**
   * Close peer connection
   */
  close() {
    if (this.pc) {
      this.pc.close();
    }
    this.iceCandidates = [];
    this.dataChannels.clear();
  }
}

/**
 * Factory function to create WebRTC peer with specified library
 * @param {string} libraryName - Library to use (werift, wrtc, node-datachannel)
 * @param {object} options - Peer connection options
 * @returns {Promise<WebRTCPeer|null>} Initialized peer or null if library not available
 */
export async function createWebRTCPeer(libraryName = 'werift', options = {}) {
  const library = await loadWebRTCLibrary(libraryName);
  
  if (!library) {
    return null;
  }

  const peer = new WebRTCPeer(library, libraryName, options);
  await peer.init(options.config || {});
  
  return peer;
}
