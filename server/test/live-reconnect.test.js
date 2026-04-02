/**
 * Live reconnect test against the hosted coordinator.
 *
 * Run with: node --test server/test/live-reconnect.test.js
 *
 * Requires UDP access to channel.wayservepro.com:3478.
 * Tests skip gracefully when the coordinator is unreachable.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import dgram from 'dgram';
import { UDPClient } from '../../shared/protocol.js';
import { loadKeys, generateSigningKeyPair } from '../../shared/keys.js';
import path from 'path';
import { promises as fsPromises } from 'fs';

const CONFIG_DIR = path.join(process.env.HOME || '/root', '.config', 'homechannel');
const PRIVATE_KEY_PATH = path.join(CONFIG_DIR, 'server.key');
const PUBLIC_KEY_PATH = path.join(CONFIG_DIR, 'server.pub');
const COORDINATOR_HOST = 'channel.wayservepro.com';
const COORDINATOR_PORT = 3478;

async function loadOrGenerateKeys() {
  try {
    const keys = await loadKeys(PRIVATE_KEY_PATH, PUBLIC_KEY_PATH);
    if (keys) return keys;
  } catch { /* fall through */ }
  return generateSigningKeyPair('ed448');
}

/** Returns true if we can send a UDP packet to the coordinator (no OS-level block). */
async function canReachCoordinator() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); resolve(false); }, 3000);
    sock.send(Buffer.from([0x01, 0x01]), COORDINATOR_PORT, COORDINATOR_HOST, (err) => {
      clearTimeout(timer);
      sock.close();
      resolve(!err);
    });
  });
}

describe('Live reconnect against hosted coordinator', () => {
  let serverKeys;
  let coordinatorReachable = false;

  before(async () => {
    serverKeys = await loadOrGenerateKeys();
    try {
      const raw = await fsPromises.readFile(path.join(CONFIG_DIR, 'server.json'), 'utf8');
      serverKeys.password = JSON.parse(raw).password || 'change-me';
    } catch {
      serverKeys.password = 'change-me';
    }
    coordinatorReachable = await canReachCoordinator();
    if (!coordinatorReachable) {
      console.log('  [SKIP] Cannot reach coordinator via UDP — skipping live tests');
    }
  });

  test('should register with hosted coordinator', async (t) => {
    if (!coordinatorReachable) { t.skip('Coordinator unreachable'); return; }

    const client = new UDPClient(COORDINATOR_HOST, COORDINATOR_PORT, serverKeys, {
      helloMaxRetries: 3,
      helloTimeoutMs: 3000
    });

    let registered = false;
    await client.start();
    await Promise.race([
      new Promise(resolve => client.on('registered', () => { registered = true; resolve(); })),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Registration timed out (15s)')), 15000))
    ]);
    assert.ok(registered);
    assert.strictEqual(client.state, 'registered');
    await client.stop();
  });

  test('should automatically reconnect after dead connection', async (t) => {
    if (!coordinatorReachable) { t.skip('Coordinator unreachable'); return; }

    const client = new UDPClient(COORDINATOR_HOST, COORDINATOR_PORT, serverKeys, {
      helloMaxRetries: 3,
      helloTimeoutMs: 3000,
      keepaliveIntervalMs: 500,  // fast for testing
      deadIntervalMs: 1500,
      reconnectDelayMs: 200,
      maxReconnectDelayMs: 5000
    });

    let registeredCount = 0;
    let reconnectFired = false;
    client.on('registered', () => { registeredCount++; });
    client.on('reconnecting', () => { reconnectFired = true; });

    await client.start();
    await Promise.race([
      new Promise(resolve => {
        client.on('registered', () => { if (registeredCount >= 1) resolve(); });
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Initial registration timed out (15s)')), 15000))
    ]);

    assert.strictEqual(registeredCount, 1);
    console.log('  Initial registration done. Simulating dead connection...');

    // Simulate: coordinator silent for longer than deadIntervalMs
    client.lastReceivedMs = Date.now() - 2000;

    await Promise.race([
      new Promise(resolve => {
        const check = setInterval(() => {
          if (registeredCount >= 2) { clearInterval(check); resolve(); }
        }, 100);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Re-registration timed out (20s)')), 20000))
    ]);

    assert.ok(reconnectFired, 'reconnecting event should have fired');
    assert.ok(registeredCount >= 2, `should re-register (got ${registeredCount})`);
    assert.strictEqual(client.state, 'registered');
    console.log(`  Re-registration confirmed (${registeredCount} total registrations)`);

    await client.stop();
  });
});
