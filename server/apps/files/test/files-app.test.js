import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import { run } from '../index.js';

describe('Files App', () => {
  let testDir;
  let appInstance;

  before(async () => {
    testDir = path.join(os.tmpdir(), 'hc-files-app-test-' + Date.now());
    await fsPromises.mkdir(testDir, { recursive: true });
    await fsPromises.writeFile(path.join(testDir, 'sample.txt'), 'hello');

    appInstance = await run({
      config: {
        rootDir: testDir,
        allowedDirs: [testDir]
      }
    });
  });

  after(async () => {
    try {
      await fsPromises.rm(testDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  });

  it('should return an instance with handleMessage', () => {
    assert.ok(appInstance);
    assert.strictEqual(typeof appInstance.handleMessage, 'function');
  });

  it('should list directory contents', async () => {
    const res = await appInstance.handleMessage({
      requestId: 'f-1',
      operation: 'listDirectory',
      params: { path: testDir }
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.requestId, 'f-1');
    const names = res.result.items.map(i => i.name);
    assert.ok(names.includes('sample.txt'));
  });

  it('should read file', async () => {
    const res = await appInstance.handleMessage({
      requestId: 'f-2',
      operation: 'readFile',
      params: { path: path.join(testDir, 'sample.txt') }
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.result.content, 'hello');
  });

  it('should write and verify file', async () => {
    const filePath = path.join(testDir, 'written.txt');
    const writeRes = await appInstance.handleMessage({
      requestId: 'f-3',
      operation: 'writeFile',
      params: { path: filePath, content: 'test data', encoding: 'utf8' }
    });
    assert.strictEqual(writeRes.success, true);

    const readRes = await appInstance.handleMessage({
      requestId: 'f-4',
      operation: 'readFile',
      params: { path: filePath }
    });
    assert.strictEqual(readRes.result.content, 'test data');
  });

  it('should return error for missing requestId', async () => {
    const res = await appInstance.handleMessage({
      operation: 'listDirectory',
      params: { path: testDir }
    });
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('Missing requestId'));
  });

  it('should return error for missing operation', async () => {
    const res = await appInstance.handleMessage({
      requestId: 'f-5',
      params: { path: testDir }
    });
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('Missing operation'));
  });

  it('should return error for unknown operation', async () => {
    const res = await appInstance.handleMessage({
      requestId: 'f-6',
      operation: 'destroyAll',
      params: {}
    });
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('Unknown operation'));
  });

  it('should block private method access', async () => {
    const res = await appInstance.handleMessage({
      requestId: 'f-7',
      operation: '_internal',
      params: {}
    });
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('Unknown operation'));
  });

  it('should block constructor access', async () => {
    const res = await appInstance.handleMessage({
      requestId: 'f-8',
      operation: 'constructor',
      params: {}
    });
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('Unknown operation'));
  });

  it('should handle file not found gracefully', async () => {
    const res = await appInstance.handleMessage({
      requestId: 'f-9',
      operation: 'readFile',
      params: { path: path.join(testDir, 'nope.txt') }
    });
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('not found') || res.error.includes('File not found'));
  });
});
