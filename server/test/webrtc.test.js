/**
 * Tests for WebRTC library abstraction and configuration
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { loadWebRTCLibrary, createWebRTCPeer, WebRTCPeer, checkWebRTCLibraries, displayWebRTCStatus } from '../webrtc.js';
import fs from 'fs';

describe('WebRTC Library Abstraction', () => {
  
  describe('loadWebRTCLibrary', () => {
    it('should return null for non-existent library', async () => {
      const library = await loadWebRTCLibrary('non-existent-webrtc-lib', true);
      assert.strictEqual(library, null);
    });

    it('should handle library name gracefully', async () => {
      // These may or may not be installed, but should handle gracefully
      const libraries = ['werift', 'wrtc', 'node-datachannel'];
      
      for (const name of libraries) {
        const library = await loadWebRTCLibrary(name, true);
        // Should return either object or null, not throw
        assert.ok(library === null || typeof library === 'object');
      }
    });
  });

  describe('WebRTCPeer', () => {
    it('should initialize with mock library', async () => {
      // Create a mock library
      const mockLibrary = {
        RTCPeerConnection: class {
          constructor() {
            this.connectionState = 'new';
          }
          close() {}
        }
      };

      const peer = new WebRTCPeer(mockLibrary, 'werift', {});
      assert.ok(peer);
      assert.strictEqual(peer.libraryName, 'werift');
    });

    it('should throw error when initializing without library', async () => {
      const peer = new WebRTCPeer(null, 'none', {});
      
      await assert.rejects(
        async () => await peer.init(),
        { message: 'WebRTC library not loaded' }
      );
    });

    it('should store event handlers', () => {
      const mockLibrary = { RTCPeerConnection: class {} };
      const peer = new WebRTCPeer(mockLibrary, 'werift', {});
      
      const handler = () => {};
      peer.on('test-event', handler);
      
      assert.strictEqual(peer.handlers.get('test-event'), handler);
    });

    it('should manage ICE candidates list', () => {
      const mockLibrary = { RTCPeerConnection: class {} };
      const peer = new WebRTCPeer(mockLibrary, 'werift', {});
      
      assert.strictEqual(peer.getICECandidates().length, 0);
      
      peer.iceCandidates.push({ candidate: 'test' });
      assert.strictEqual(peer.getICECandidates().length, 1);
    });
  });

  describe('Configuration', () => {
    it('should read webrtc library from config', () => {
      const configPath = '../config.json';
      
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        if (config.webrtc?.library) {
          assert.ok(['werift', 'wrtc', 'node-datachannel'].includes(config.webrtc.library));
        }
      }
    });
  });

  describe('createWebRTCPeer factory', () => {
    it('should return null for non-existent library', async () => {
      const peer = await createWebRTCPeer('non-existent-lib');
      assert.strictEqual(peer, null);
    });
  });

  describe('checkWebRTCLibraries', () => {
    it('should return available and missing libraries', async () => {
      const { available, missing } = await checkWebRTCLibraries();
      
      // Should return arrays
      assert.ok(Array.isArray(available));
      assert.ok(Array.isArray(missing));
      
      // Should have 3 libraries total
      assert.strictEqual(available.length + missing.length, 3);
      
      // All entries should be known library names
      const allLibs = [...available, ...missing];
      for (const lib of allLibs) {
        assert.ok(['werift', 'wrtc', 'node-datachannel'].includes(lib));
      }
    });

    it('should not duplicate libraries', async () => {
      const { available, missing } = await checkWebRTCLibraries();
      
      // No library should appear in both lists
      for (const lib of available) {
        assert.ok(!missing.includes(lib));
      }
    });
  });

  describe('displayWebRTCStatus', () => {
    it('should not throw when displaying status', async () => {
      // Just verify it doesn't throw
      await assert.doesNotReject(async () => {
        await displayWebRTCStatus();
      });
    });
  });
});
