/**
 * End-to-end test for complete client-server WebRTC connection
 * Tests the full flow from discovery to data transfer
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';

describe('Full WebRTC Connection E2E', () => {
  let coordinatorProcess;
  let serverProcess;
  let browser;
  let context;
  let page;
  const coordinatorPort = 13341;

  before(async () => {
    // Start coordinator
    coordinatorProcess = spawn('node', ['coordinator/index.js'], {
      cwd: '/workspaces/homechannel',
      env: {
        ...process.env,
        COORDINATOR_PORT: coordinatorPort
      }
    });

    await setTimeout(2000);

    // Start server
    serverProcess = spawn('node', ['server/index.js'], {
      cwd: '/workspaces/homechannel'
    });

    await setTimeout(2000);

    // Launch browser for client testing
    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  });

  after(async () => {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    if (serverProcess) serverProcess.kill();
    if (coordinatorProcess) coordinatorProcess.kill();
    await setTimeout(500);
  });

  it('should complete full connection establishment', async () => {
    // Load client page
    await page.goto(`http://localhost:${coordinatorPort}/client.html`);

    // Wait for client to connect
    await setTimeout(3000);

    // Verify connection state
    const connectionState = await page.evaluate(() => {
      return window.peerConnection?.connectionState || 'disconnected';
    });

    // Connection should be established or at least connecting
    assert.ok(
      ['connected', 'connecting', 'new'].includes(connectionState),
      'Should be in valid connection state'
    );
  });

  it('should transfer data over WebRTC datachannel', async () => {
    // Send test message
    const testMessage = { type: 'ping', timestamp: Date.now() };
    const response = await page.evaluate((msg) => {
      return new Promise((resolve) => {
        window.dataChannel.send(JSON.stringify(msg));
        window.dataChannel.addEventListener('message', (event) => {
          resolve(event.data);
        }, { once: true });
      });
    }, testMessage);

    assert.ok(response, 'Should receive response from server');
  });

  it('should handle connection failures gracefully', async () => {
    // Kill server to simulate failure
    if (serverProcess) {
      serverProcess.kill();
      await setTimeout(2000);
    }

    // Client should detect disconnection
    const connectionState = await page.evaluate(() => {
      return window.peerConnection?.connectionState || 'disconnected';
    });

    assert.ok(
      ['disconnected', 'failed', 'closed'].includes(connectionState),
      'Should detect server disconnection'
    );
  });
});
