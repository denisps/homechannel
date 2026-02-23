import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Client } from '../apps/client.js';

/**
 * Mock browser APIs for testing app features
 */
class MockRTCPeerConnection {
  constructor() {
    this.connectionState = 'new';
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    this._channels = {};
  }

  createDataChannel(label, options) {
    const ch = new MockRTCDataChannel(label, options);
    this._channels[label] = ch;
    // Simulate immediate open
    setTimeout(() => {
      ch.readyState = 'open';
      if (ch.onopen) ch.onopen();
    }, 5);
    return ch;
  }

  async createOffer() { return { type: 'offer', sdp: 'mock' }; }
  async setLocalDescription(d) {
    setTimeout(() => {
      if (this.onicecandidate) this.onicecandidate({ candidate: null });
    }, 5);
  }
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
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
    this._sent = [];
  }
  send(data) { this._sent.push(data); }
  close() {
    this.readyState = 'closed';
    if (this.onclose) this.onclose();
  }
  addEventListener(event, handler) { this[`on${event}`] = handler; }
  removeEventListener(event) { this[`on${event}`] = null; }
}

class MockDocument {
  constructor() {
    this.body = {
      appendChild: (el) => { setTimeout(() => { if (el.onload) el.onload(); }, 5); },
      removeChild: () => {}
    };
  }
  createElement(tag) {
    if (tag === 'iframe') {
      return {
        src: '', srcdoc: '', sandbox: '', style: {},
        onload: null, onerror: null, parentNode: null,
        contentWindow: { postMessage: () => {} }
      };
    }
    return { src: '', srcdoc: '', sandbox: '', style: {} };
  }
}

class MockWindow {
  constructor() { this.messageHandlers = []; }
  addEventListener(event, handler) { if (event === 'message') this.messageHandlers.push(handler); }
  removeEventListener() {}
}

function setupMocks() {
  global.RTCPeerConnection = MockRTCPeerConnection;
  global.document = new MockDocument();
  global.window = new MockWindow();
}

describe('Client App Discovery', () => {
  let client;

  before(() => { setupMocks(); });

  beforeEach(() => {
    client = new Client('https://coord.example.com');
    global.window = new MockWindow();
  });

  afterEach(() => { client.disconnect(); });

  test('constructor initializes app properties', () => {
    assert.ok(client.appChannels instanceof Map);
    assert.ok(client.controlRequests instanceof Map);
    assert.ok(client.appIframes instanceof Map);
    assert.deepStrictEqual(client.apps, []);
    assert.strictEqual(client.controlChannel, null);
  });

  test('on() accepts appsLoaded event', () => {
    const handler = () => {};
    client.on('appsLoaded', handler);
    assert.strictEqual(client.handlers.appsLoaded.length, 1);
  });

  test('requestAppList() throws when not connected', async () => {
    await assert.rejects(() => client.requestAppList(), /Not connected/);
  });

  test('requestAppList() sends control message and receives list', async () => {
    // Simulate connected state
    await client.createPeerConnection();
    client.state = 'connected';

    let appsEmitted = null;
    client.on('appsLoaded', (apps) => { appsEmitted = apps; });

    // Start the request (don't await yet)
    const promise = client.requestAppList();

    // Wait for channel to open and handler to be set
    await new Promise(r => setTimeout(r, 20));

    // Verify control channel was created
    assert.ok(client.controlChannel);
    assert.strictEqual(client.controlChannel.label, 'apps-control');

    // Verify a message was sent
    const sent = client.controlChannel._sent;
    assert.ok(sent.length > 0);
    const request = JSON.parse(sent[0]);
    assert.strictEqual(request.type, 'apps:list');

    // Deliver response through _handleControlMessage directly
    client._handleControlMessage(JSON.stringify({
      type: 'apps:list:response',
      requestId: request.requestId,
      apps: [{ name: 'files', version: '1.0.0' }]
    }));

    const apps = await promise;
    assert.strictEqual(apps.length, 1);
    assert.strictEqual(apps[0].name, 'files');
    assert.deepStrictEqual(appsEmitted, apps);
  });

  test('openAppChannel() creates per-app channel', async () => {
    await client.createPeerConnection();
    client.state = 'connected';

    const channel = await client.openAppChannel('files');
    assert.ok(channel);
    assert.strictEqual(channel.label, 'files');
    assert.ok(client.appChannels.has('files'));
  });

  test('openAppChannel() rejects reserved name', async () => {
    await client.createPeerConnection();
    client.state = 'connected';

    await assert.rejects(
      () => client.openAppChannel('apps-control'),
      /reserved channel/
    );
  });

  test('openAppChannel() throws when not connected', async () => {
    await assert.rejects(() => client.openAppChannel('files'), /Not connected/);
  });

  test('loadAppInSandbox() creates sandboxed iframe', () => {
    const container = {
      children: [],
      appendChild(el) { this.children.push(el); }
    };

    const iframe = client.loadAppInSandbox('files', 'console.log("hi")', container);
    assert.ok(iframe);
    assert.strictEqual(iframe.sandbox, 'allow-scripts');
    assert.ok(iframe.srcdoc.includes('console.log("hi")'));
    assert.ok(iframe.srcdoc.includes('type="module"'));
    assert.ok(client.appIframes.has('files'));
  });

  test('closePeerConnection() cleans up app resources', async () => {
    await client.createPeerConnection();
    client.state = 'connected';

    await client.openAppChannel('files');

    // Add a pending control request
    const promise = new Promise((resolve, reject) => {
      client.controlRequests.set('test-req', { resolve, reject });
    });

    client.closePeerConnection();

    assert.strictEqual(client.appChannels.size, 0);
    assert.strictEqual(client.controlRequests.size, 0);
    assert.strictEqual(client.appIframes.size, 0);
    assert.strictEqual(client.controlChannel, null);

    // The pending request should be rejected
    await assert.rejects(promise, /Client disconnected/);
  });

  test('_handleControlMessage resolves pending request', () => {
    let resolved = null;
    client.controlRequests.set('req-1', {
      resolve: (data) => { resolved = data; },
      reject: () => {}
    });

    client._handleControlMessage(JSON.stringify({
      requestId: 'req-1',
      apps: [{ name: 'files' }]
    }));

    assert.ok(resolved);
    assert.deepStrictEqual(resolved.apps, [{ name: 'files' }]);
    assert.strictEqual(client.controlRequests.size, 0);
  });

  test('_handleControlMessage rejects on error', async () => {
    let rejected = null;
    client.controlRequests.set('req-2', {
      resolve: () => {},
      reject: (err) => { rejected = err; }
    });

    client._handleControlMessage(JSON.stringify({
      requestId: 'req-2',
      error: 'test error'
    }));

    assert.ok(rejected);
    assert.ok(rejected.message.includes('test error'));
  });
});
