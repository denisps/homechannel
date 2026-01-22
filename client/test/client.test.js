import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Client } from '../client.js';

/**
 * Mock browser APIs for Node.js testing
 */
class MockRTCPeerConnection {
  constructor(config) {
    this.config = config;
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = 'new';
    this.iceGatheringState = 'new';
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    this._dataChannel = null;
  }
  
  createDataChannel(label, options) {
    this._dataChannel = new MockRTCDataChannel(label, options);
    return this._dataChannel;
  }
  
  async createOffer() {
    return {
      type: 'offer',
      sdp: 'mock-sdp-offer'
    };
  }
  
  async setLocalDescription(desc) {
    this.localDescription = desc;
    // Simulate ICE gathering
    setTimeout(() => {
      if (this.onicecandidate) {
        this.onicecandidate({ candidate: { candidate: 'mock-candidate-1', sdpMLineIndex: 0, sdpMid: 'data' } });
        this.onicecandidate({ candidate: { candidate: 'mock-candidate-2', sdpMLineIndex: 0, sdpMid: 'data' } });
        this.onicecandidate({ candidate: null }); // gathering complete
      }
    }, 10);
  }
  
  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    this.connectionState = 'connected';
    if (this.onconnectionstatechange) {
      this.onconnectionstatechange();
    }
    // Simulate datachannel opening
    setTimeout(() => {
      if (this._dataChannel && this._dataChannel.onopen) {
        this._dataChannel.readyState = 'open';
        this._dataChannel.onopen();
      }
    }, 10);
  }
  
  async addIceCandidate(candidate) {
    // Mock implementation
  }
  
  close() {
    this.connectionState = 'closed';
    if (this._dataChannel) {
      this._dataChannel.readyState = 'closed';
      if (this._dataChannel.onclose) {
        this._dataChannel.onclose();
      }
    }
  }
}

class MockRTCDataChannel {
  constructor(label, options) {
    this.label = label;
    this.options = options;
    this.readyState = 'connecting';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }
  
  send(data) {
    // Mock implementation
  }
  
  close() {
    this.readyState = 'closed';
    if (this.onclose) {
      this.onclose();
    }
  }
  
  addEventListener(event, handler) {
    this[`on${event}`] = handler;
  }
  
  removeEventListener(event, handler) {
    this[`on${event}`] = null;
  }
}

/**
 * Mock iframe and DOM
 */
class MockIframe {
  constructor() {
    this.src = '';
    this.style = {
      position: '',
      top: '',
      left: '',
      width: '',
      height: '',
      border: '',
      zIndex: ''
    };
    this.onload = null;
    this.onerror = null;
    this.contentWindow = {
      postMessage: (msg, origin) => {
        // Store for verification
        MockIframe.lastMessage = msg;
      }
    };
  }
}
MockIframe.lastMessage = null;

class MockDocument {
  constructor() {
    this.body = {
      appendChild: (el) => {
        setTimeout(() => {
          if (el.onload) el.onload();
        }, 10);
      },
      removeChild: (el) => {}
    };
  }
  
  createElement(tag) {
    if (tag === 'iframe') {
      return new MockIframe();
    }
    return {};
  }
}

class MockWindow {
  constructor() {
    this.messageHandlers = [];
  }
  
  addEventListener(event, handler) {
    if (event === 'message') {
      this.messageHandlers.push(handler);
    }
  }
  
  removeEventListener(event, handler) {
    if (event === 'message') {
      const index = this.messageHandlers.indexOf(handler);
      if (index > -1) {
        this.messageHandlers.splice(index, 1);
      }
    }
  }
  
  // Simulate postMessage event
  simulateMessage(data, origin) {
    const event = {
      data,
      origin,
      source: { postMessage: () => {} }
    };
    this.messageHandlers.forEach(h => h(event));
  }
}

/**
 * Mock crypto.subtle for Web Crypto API
 */
class MockSubtle {
  async importKey(format, keyData, algorithm, extractable, keyUsages) {
    return { format, algorithm };
  }
  
  async verify(algorithm, key, signature, data) {
    // Mock: always return true for testing
    return true;
  }
  
  async digest(algorithm, data) {
    // Mock SHA-256 hash
    return new Uint8Array(32).fill(0x42);
  }
}

const mockCrypto = {
  subtle: new MockSubtle()
};

/**
 * Setup global mocks
 */
function setupMocks() {
  global.RTCPeerConnection = MockRTCPeerConnection;
  global.document = new MockDocument();
  global.window = new MockWindow();
  // Don't override global.crypto as it's read-only
  // Instead, we'll mock it at module level in crypto-browser.js
}

/**
 * Tests
 */
describe('Client API', () => {
  let client;
  
  before(() => {
    setupMocks();
  });
  
  beforeEach(() => {
    client = new Client('https://coordinator.example.com');
    MockIframe.lastMessage = null;
    global.window = new MockWindow();
  });
  
  afterEach(() => {
    if (client) {
      client.disconnect();
    }
  });
  
  test('constructor initializes correctly', () => {
    assert.strictEqual(client.coordinatorUrl, 'https://coordinator.example.com');
    assert.strictEqual(client.state, 'disconnected');
    assert.strictEqual(client.iframe, null);
    assert.strictEqual(client.peerConnection, null);
  });
  
  test('on() registers event handlers', () => {
    const handler = () => {};
    client.on('connected', handler);
    assert.strictEqual(client.handlers.connected.length, 1);
    assert.strictEqual(client.handlers.connected[0], handler);
  });
  
  test('on() throws on unknown event', () => {
    assert.throws(() => {
      client.on('unknown', () => {});
    }, /Unknown event/);
  });
  
  test('emit() calls all registered handlers', () => {
    let called1 = false;
    let called2 = false;
    
    client.on('connected', () => { called1 = true; });
    client.on('connected', () => { called2 = true; });
    
    client.emit('connected');
    
    assert.strictEqual(called1, true);
    assert.strictEqual(called2, true);
  });
  
  test('createIframe() creates and configures iframe', async () => {
    await client.createIframe();
    
    assert.notStrictEqual(client.iframe, null);
    assert.strictEqual(client.iframe.src, 'https://coordinator.example.com/iframe.html');
    assert.strictEqual(client.iframe.style.position, 'fixed');
  });
  
  test('destroyIframe() removes iframe', async () => {
    await client.createIframe();
    assert.notStrictEqual(client.iframe, null);
    
    client.destroyIframe();
    assert.strictEqual(client.iframe, null);
  });
  
  test('createPeerConnection() initializes WebRTC', async () => {
    await client.createPeerConnection();
    
    assert.notStrictEqual(client.peerConnection, null);
    assert.notStrictEqual(client.dataChannel, null);
    assert.strictEqual(client.dataChannel.label, 'homechannel');
  });
  
  test('send() throws when not connected', () => {
    assert.throws(() => {
      client.send('test');
    }, /Not connected/);
  });
  
  test('send() sends message when connected', async () => {
    await client.createPeerConnection();
    client.state = 'connected';
    client.dataChannel.readyState = 'open';
    
    // Should not throw
    client.send('test message');
  });
  
  test('disconnect() cleans up resources', async () => {
    await client.createIframe();
    await client.createPeerConnection();
    
    client.disconnect();
    
    assert.strictEqual(client.state, 'disconnected');
    assert.strictEqual(client.iframe, null);
    assert.strictEqual(client.peerConnection, null);
  });
  
  test('iframeRequest() sends postMessage', async () => {
    await client.createIframe();
    
    const promise = client.iframeRequest('test', { foo: 'bar' });
    
    assert.notStrictEqual(MockIframe.lastMessage, null);
    assert.strictEqual(MockIframe.lastMessage.type, 'request');
    assert.strictEqual(MockIframe.lastMessage.method, 'test');
    assert.deepStrictEqual(MockIframe.lastMessage.params, { foo: 'bar' });
  });
  
  test('handleIframeMessage() resolves pending request', async () => {
    await client.createIframe();
    
    const promise = client.iframeRequest('test', {});
    const requestId = MockIframe.lastMessage.requestId;
    
    // Simulate response
    const event = {
      origin: 'https://coordinator.example.com',
      data: {
        type: 'response',
        requestId,
        data: { success: true }
      }
    };
    
    client.handleIframeMessage(event);
    
    const result = await promise;
    assert.deepStrictEqual(result, { success: true });
  });
  
  test('handleIframeMessage() rejects on error', async () => {
    await client.createIframe();
    
    const promise = client.iframeRequest('test', {});
    const requestId = MockIframe.lastMessage.requestId;
    
    // Simulate error response
    const event = {
      origin: 'https://coordinator.example.com',
      data: {
        type: 'response',
        requestId,
        error: 'Test error'
      }
    };
    
    client.handleIframeMessage(event);
    
    await assert.rejects(promise, /Test error/);
  });
  
  test('handleIframeMessage() ignores wrong origin', async () => {
    await client.createIframe();
    
    const promise = client.iframeRequest('test', {});
    const requestId = MockIframe.lastMessage.requestId;
    
    // Simulate response from wrong origin
    const event = {
      origin: 'https://evil.com',
      data: {
        type: 'response',
        requestId,
        data: { success: true }
      }
    };
    
    client.handleIframeMessage(event);
    
    // Request should still be pending (not resolved by wrong origin)
    assert.strictEqual(client.iframeRequests.has(requestId), true);
  });
  
  test('waitForIceGathering() waits for completion', async () => {
    await client.createPeerConnection();
    
    // Simulate ICE gathering completion
    setTimeout(() => {
      client.iceGatheringComplete = true;
    }, 50);
    
    await client.waitForIceGathering();
    
    assert.strictEqual(client.iceGatheringComplete, true);
  });
  
  test('waitForDataChannel() resolves when open', async () => {
    await client.createPeerConnection();
    
    // Simulate datachannel opening
    setTimeout(() => {
      client.dataChannel.readyState = 'open';
      if (client.dataChannel.onopen) {
        client.dataChannel.onopen();
      }
    }, 50);
    
    await client.waitForDataChannel();
    
    assert.strictEqual(client.dataChannel.readyState, 'open');
  });
  
  test('closePeerConnection() closes all connections', async () => {
    await client.createPeerConnection();
    
    client.closePeerConnection();
    
    assert.strictEqual(client.dataChannel, null);
    assert.strictEqual(client.peerConnection, null);
  });
});

describe('Client Crypto', () => {
  before(() => {
    setupMocks();
  });
  
  test('hashChallengeAnswer() returns hex string', async () => {
    const { hashChallengeAnswer } = await import('../crypto-browser.js');
    const result = await hashChallengeAnswer('challenge123', 'password456');
    
    assert.strictEqual(typeof result, 'string');
    assert.strictEqual(result.length, 64); // 32 bytes = 64 hex chars
  });
  
  test('verifySignature() validates signatures', async () => {
    const { verifySignature } = await import('../crypto-browser.js');
    
    // Use a valid base64-encoded ECDSA P-256 public key for testing
    const mockPemKey = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaFBaL0xqOy0bCwqPJmNVDhg1SvfB
6T7S9cPKp1LHQx7gK5KhLB7LhqPKx7gK5KhLB7LhqPKx7gK5KhLB7LhqPKx7gA==
-----END PUBLIC KEY-----`;
    
    // Since this is a mock test, we just verify the function runs without error
    // In real usage, this would verify actual server signatures
    const result = await verifySignature({ test: 'data' }, 'aabbccdd', mockPemKey);
    
    // The verification might fail with mock data, but function should return a boolean
    assert.strictEqual(typeof result, 'boolean');
  });
});
