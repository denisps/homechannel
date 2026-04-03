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

// ── Binary channel framing ────────────────────────────────────────────────────
// Frame format: [type:uint8][payloadLen:uint32BE][payload]
const FRAME_JSON   = 0x01; // UTF-8 JSON  (command / response)
const FRAME_CHUNK  = 0x02; // raw binary  (file stream chunk)
const FRAME_END    = 0x03; // JSON: { requestId, size? } — stream finished
const FRAME_CANCEL = 0x04; // JSON: { requestId }        — abort stream
const APP_CHUNK_SIZE = 65536; // 64 KB per chunk

function framePack(type, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(5 + buf.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(buf.length, 1);
  buf.copy(frame, 5);
  return frame;
}

function frameUnpack(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 5) throw new Error('Frame too short');
  const type = buf.readUInt8(0);
  const len  = buf.readUInt32BE(1);
  return { type, payload: buf.slice(5, 5 + len) };
}

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
    this.iceGatheringComplete = false;
    this._iceGatheringResolve = null;
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
    this.iceGatheringComplete = false;
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.iceCandidates.push(event.candidate);
        if (this.handlers.has('icecandidate')) {
          this.handlers.get('icecandidate')(event.candidate);
        }
      } else {
        // null candidate signals ICE gathering complete
        this.iceGatheringComplete = true;
        if (this._iceGatheringResolve) {
          this._iceGatheringResolve();
          this._iceGatheringResolve = null;
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
   * Core framed app-channel handler, shared by W3C and node-datachannel paths.
   * sendBuf(Buffer) — sends a binary frame over the channel.
   */
  async _handleAppFrame(rawData, appName, state, sendBuf) {
    const buf = Buffer.isBuffer(rawData) ? rawData
      : rawData instanceof ArrayBuffer ? Buffer.from(rawData)
      : Buffer.from(rawData);

    let ft, payload;
    try {
      ({ type: ft, payload } = frameUnpack(buf));
    } catch {
      // Fallback: old-protocol plain JSON string
      try {
        const msg = JSON.parse(buf.toString('utf8'));
        const resp = await this.serviceRouter.handleAppMessage(appName, msg);
        sendBuf(framePack(FRAME_JSON, JSON.stringify(resp)));
      } catch { /* ignore malformed */ }
      return;
    }

    if (ft === FRAME_JSON) {
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }

      if (msg.operation === 'readFile') {
        await this._streamFileToChannel(appName, msg.requestId, msg.params, sendBuf);
      } else if (msg.operation === 'writeFile' &&
                 msg.params && typeof msg.params.size === 'number' &&
                 !msg.params.content) {
        // Chunked upload — wait for FRAME_CHUNK + FRAME_END
        state.upload = { requestId: msg.requestId, params: msg.params, chunks: [], received: 0 };
        sendBuf(framePack(FRAME_JSON, JSON.stringify({ requestId: msg.requestId, uploading: true })));
      } else {
        const resp = await this.serviceRouter.handleAppMessage(appName, msg);
        sendBuf(framePack(FRAME_JSON, JSON.stringify(resp)));
      }
    } else if (ft === FRAME_CHUNK && state.upload) {
      state.upload.chunks.push(Buffer.from(payload));
      state.upload.received += payload.length;
    } else if (ft === FRAME_END && state.upload) {
      const up = state.upload;
      state.upload = null;
      try {
        const content = Buffer.concat(up.chunks);
        const resp = await this.serviceRouter.handleAppMessage(appName, {
          requestId: up.requestId,
          operation: 'writeFile',
          params: { path: up.params.path, content: content.toString('base64'), encoding: 'base64' }
        });
        sendBuf(framePack(FRAME_JSON, JSON.stringify(resp)));
      } catch (err) {
        sendBuf(framePack(FRAME_JSON, JSON.stringify(
          { requestId: up.requestId, success: false, error: err.message }
        )));
      }
    } else if (ft === FRAME_CANCEL && state.upload) {
      state.upload = null;
    }
  }

  /**
   * Stream a file to the channel in binary chunks.
   */
  async _streamFileToChannel(appName, requestId, params, sendBuf) {
    try {
      const appInst = this.serviceRouter.apps.get(appName)?.instance;

      if (appInst && typeof appInst.streamFile === 'function') {
        let totalSize = 0;
        for await (const item of appInst.streamFile(params)) {
          if (item.type === 'meta') {
            totalSize = item.size;
            sendBuf(framePack(FRAME_JSON, JSON.stringify({
              requestId, streaming: true,
              result: { size: item.size, mimeType: item.mimeType }
            })));
          } else if (item.type === 'chunk') {
            sendBuf(framePack(FRAME_CHUNK, item.data));
          }
        }
        sendBuf(framePack(FRAME_END, JSON.stringify({ requestId, size: totalSize })));
      } else {
        // Fallback: read whole file, send in chunks
        const resp = await this.serviceRouter.handleAppMessage(appName,
          { requestId: `${requestId}_r`, operation: 'readFile', params });
        if (!resp.success) {
          sendBuf(framePack(FRAME_JSON, JSON.stringify({ requestId, success: false, error: resp.error })));
          return;
        }
        const content = resp.result.encoding === 'base64'
          ? Buffer.from(resp.result.content, 'base64')
          : Buffer.from(resp.result.content, 'utf8');
        sendBuf(framePack(FRAME_JSON, JSON.stringify({
          requestId, streaming: true,
          result: { size: content.length, mimeType: resp.result.mimeType }
        })));
        for (let off = 0; off < content.length; off += APP_CHUNK_SIZE) {
          sendBuf(framePack(FRAME_CHUNK, content.slice(off, off + APP_CHUNK_SIZE)));
        }
        sendBuf(framePack(FRAME_END, JSON.stringify({ requestId, size: content.length })));
      }
    } catch (err) {
      sendBuf(framePack(FRAME_JSON, JSON.stringify({ requestId, success: false, error: err.message })));
    }
  }

  /**
   * Setup app channel handlers (W3C)
   * Sends bundle on open, then handles framed app messages
   */
  _setupAppChannelHandlers(dc, appName) {
    const state = { upload: null };
    const sendBuf = (buf) => dc.send(buf);

    dc.onopen = async () => await this._sendAppBundle(dc, appName);

    dc.onmessage = async (event) => {
      await this._handleAppFrame(event.data, appName, state, sendBuf);
    };

    dc.onclose = () => { state.upload = null; };
    dc.onerror = (e) => console.error(`App channel error [${appName}]:`, e);
  }

  /**
   * Setup app channel handlers (node-datachannel)
   */
  _setupAppChannelHandlersNodeDC(dc, appName) {
    const state = { upload: null };
    const sendBuf = (buf) => dc.sendMessageBinary(buf);

    dc.onOpen(async () => await this._sendAppBundleNodeDC(dc, appName));

    dc.onMessage(async (msg) => {
      await this._handleAppFrame(msg, appName, state, sendBuf);
    });

    dc.onClosed(() => { state.upload = null; });
    dc.onError((e) => console.error(`App channel error [${appName}]:`, e));
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
   * Send app bundle as a single binary-framed JSON message (W3C)
   */
  async _sendAppBundle(dc, appName) {
    try {
      const app = this.serviceRouter.apps.get(appName);
      if (!app || !app.manifest) throw new Error(`App not found: ${appName}`);

      const bundle = app.manifest.ui ? await this._loadAppUIBundle(appName, app.manifest) : null;
      const header = {
        type: 'app:bundle',
        name: app.manifest.name,
        version: app.manifest.version,
        format: app.manifest.format || 'es-module',
        bundle
      };
      dc.send(framePack(FRAME_JSON, JSON.stringify(header)));
    } catch (error) {
      console.error(`Failed to send app bundle [${appName}]:`, error);
      dc.send(framePack(FRAME_JSON, JSON.stringify({ type: 'error', error: error.message })));
    }
  }

  /**
   * Send app bundle as a single binary-framed JSON message (node-datachannel)
   */
  async _sendAppBundleNodeDC(dc, appName) {
    try {
      const app = this.serviceRouter.apps.get(appName);
      if (!app || !app.manifest) throw new Error(`App not found: ${appName}`);

      const bundle = app.manifest.ui ? await this._loadAppUIBundle(appName, app.manifest) : null;
      const header = {
        type: 'app:bundle',
        name: app.manifest.name,
        version: app.manifest.version,
        format: app.manifest.format || 'es-module',
        bundle
      };
      dc.sendMessageBinary(framePack(FRAME_JSON, JSON.stringify(header)));
    } catch (error) {
      console.error(`Failed to send app bundle [${appName}]:`, error);
      dc.sendMessageBinary(framePack(FRAME_JSON, JSON.stringify({ type: 'error', error: error.message })));
    }
  }

  /**
   * Load app UI bundle from filesystem
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
   * Wait for ICE gathering to complete or timeout
   * @param {number} timeoutMs - Max wait time in milliseconds (default 10000)
   * @returns {Promise<void>}
   */
  async waitForIceGathering(timeoutMs = 10000) {
    if (this.libraryName === 'node-datachannel') {
      // node-datachannel bundles ICE candidates in the SDP; brief wait is sufficient
      await new Promise(resolve => setTimeout(resolve, 500));
      return;
    }

    if (this.iceGatheringComplete) {
      return;
    }

    await new Promise((resolve) => {
      this._iceGatheringResolve = resolve;

      // Poll iceGatheringState for libraries that don't fire null onicecandidate (e.g. werift)
      const pollInterval = setInterval(() => {
        if (this.pc && this.pc.iceGatheringState === 'complete') {
          clearInterval(pollInterval);
          this.iceGatheringComplete = true;
          if (this._iceGatheringResolve) {
            this._iceGatheringResolve();
            this._iceGatheringResolve = null;
          }
        }
      }, 100);

      setTimeout(() => {
        clearInterval(pollInterval);
        this._iceGatheringResolve = null;
        resolve();
      }, timeoutMs);
    });
  }

  /**
   * Close peer connection
   */
  close() {
    if (this.pc) {
      this.pc.close();
    }
    this.iceCandidates = [];
    this.iceGatheringComplete = false;
    this._iceGatheringResolve = null;
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
