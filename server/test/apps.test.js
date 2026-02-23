import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import { loadApp, loadApps, validateManifest, getAppList } from '../apps/loader.js';
import { ServiceRouter } from '../services/index.js';

describe('App Loader', () => {
  describe('validateManifest', () => {
    it('should accept a valid manifest', () => {
      const result = validateManifest(
        { name: 'test', version: '1.0.0', entry: 'index.js' },
        'test'
      );
      assert.strictEqual(result.valid, true);
    });

    it('should reject null manifest', () => {
      const result = validateManifest(null, 'test');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('not a valid object'));
    });

    it('should reject manifest missing name', () => {
      const result = validateManifest({ version: '1.0.0', entry: 'index.js' }, 'test');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('name'));
    });

    it('should reject manifest missing version', () => {
      const result = validateManifest({ name: 'test', entry: 'index.js' }, 'test');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('version'));
    });

    it('should reject manifest missing entry', () => {
      const result = validateManifest({ name: 'test', version: '1.0.0' }, 'test');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('entry'));
    });

    it('should reject manifest with mismatched name', () => {
      const result = validateManifest(
        { name: 'wrong', version: '1.0.0', entry: 'index.js' },
        'test'
      );
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('does not match'));
    });
  });

  describe('loadApp', () => {
    it('should load the files app successfully', async () => {
      const result = await loadApp('files', {});
      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.strictEqual(result.name, 'files');
      assert.ok(result.manifest);
      assert.strictEqual(result.manifest.name, 'files');
      assert.ok(result.instance);
      assert.strictEqual(typeof result.instance.handleMessage, 'function');
    });

    it('should return structured error for missing app', async () => {
      const result = await loadApp('nonexistent', {});
      assert.strictEqual(result.name, 'nonexistent');
      assert.ok(result.error);
      assert.ok(result.error.includes('not found'));
    });

    it('should not throw for missing app', async () => {
      // Must not throw - returns structured error
      const result = await loadApp('does-not-exist', {});
      assert.ok(result.error);
    });
  });

  describe('loadApps', () => {
    it('should load multiple apps and report errors', async () => {
      const { loaded, errors } = await loadApps(['files', 'missing-app'], {});
      assert.strictEqual(loaded.size, 1);
      assert.ok(loaded.has('files'));
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].name, 'missing-app');
      assert.ok(errors[0].error);
    });

    it('should handle empty app list', async () => {
      const { loaded, errors } = await loadApps([], {});
      assert.strictEqual(loaded.size, 0);
      assert.strictEqual(errors.length, 0);
    });
  });

  describe('getAppList', () => {
    it('should return metadata for loaded apps', async () => {
      const { loaded } = await loadApps(['files'], {});
      const list = getAppList(loaded);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].name, 'files');
      assert.ok(list[0].version);
      assert.ok(list[0].entry);
    });
  });
});

describe('ServiceRouter Apps', () => {
  let router;

  before(async () => {
    router = new ServiceRouter({});
    await router.loadApps(['files'], {});
  });

  describe('Control channel', () => {
    it('should return app list on apps:list message', async () => {
      const response = await router.handleControlMessage({
        type: 'apps:list',
        requestId: 'ctrl-1'
      });
      assert.strictEqual(response.type, 'apps:list:response');
      assert.strictEqual(response.requestId, 'ctrl-1');
      assert.ok(Array.isArray(response.apps));
      assert.strictEqual(response.apps.length, 1);
      assert.strictEqual(response.apps[0].name, 'files');
    });

    it('should handle unknown control message type', async () => {
      const response = await router.handleControlMessage({
        type: 'unknown',
        requestId: 'ctrl-2'
      });
      assert.ok(response.error);
      assert.ok(response.error.includes('Unknown'));
    });
  });

  describe('App channel messages', () => {
    let testDir;

    before(async () => {
      testDir = path.join(os.tmpdir(), 'hc-apps-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
      await fsPromises.mkdir(testDir, { recursive: true });
      await fsPromises.writeFile(path.join(testDir, 'hello.txt'), 'world');

      // Reload with config pointing at test dir
      router = new ServiceRouter({});
      await router.loadApps(['files'], {
        files: {
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

    it('should route message to files app', async () => {
      const response = await router.handleAppMessage('files', {
        requestId: 'app-1',
        operation: 'listDirectory',
        params: { path: testDir }
      });
      assert.strictEqual(response.success, true);
      assert.strictEqual(response.requestId, 'app-1');
      assert.ok(response.result.items);
    });

    it('should read file via app channel', async () => {
      const response = await router.handleAppMessage('files', {
        requestId: 'app-2',
        operation: 'readFile',
        params: { path: path.join(testDir, 'hello.txt') }
      });
      assert.strictEqual(response.success, true);
      assert.strictEqual(response.result.content, 'world');
    });

    it('should return error for unknown app', async () => {
      const response = await router.handleAppMessage('no-such-app', {
        requestId: 'app-3',
        operation: 'list'
      });
      assert.strictEqual(response.success, false);
      assert.ok(response.error.includes('Unknown app'));
    });

    it('should return error for missing requestId', async () => {
      const response = await router.handleAppMessage('files', {
        operation: 'listDirectory',
        params: { path: testDir }
      });
      assert.strictEqual(response.success, false);
      assert.ok(response.error.includes('Missing requestId'));
    });

    it('should return error for unknown operation', async () => {
      const response = await router.handleAppMessage('files', {
        requestId: 'app-5',
        operation: 'badOp',
        params: {}
      });
      assert.strictEqual(response.success, false);
      assert.ok(response.error.includes('Unknown operation'));
    });
  });
});

describe('App Bundle Delivery', () => {
  let router;

  before(async () => {
    router = new ServiceRouter({});
    await router.loadApps(['files'], {});
  });

  it('should provide app metadata matching manifest', async () => {
    const response = await router.handleControlMessage({
      type: 'apps:list',
      requestId: 'bd-1'
    });
    const app = response.apps[0];
    assert.strictEqual(app.name, 'files');
    assert.strictEqual(app.format, 'es-module');
    assert.strictEqual(app.entry, 'index.js');
    assert.ok(app.version);
  });
});
