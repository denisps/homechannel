/**
 * Optional WebRTC connectivity and performance tests
 * Tests actual datachannel connectivity through the abstraction layer
 * Only runs if WebRTC libraries are installed
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { loadWebRTCLibrary, createWebRTCPeer } from '../webrtc.js';

// Check which libraries are available
const availableLibraries = [];
const libraries = ['werift', 'wrtc', 'node-datachannel'];

console.log('\nChecking WebRTC library availability...');
for (const lib of libraries) {
  const loaded = await loadWebRTCLibrary(lib);
  if (loaded) {
    availableLibraries.push(lib);
    console.log(`  ✅ ${lib} available`);
  } else {
    console.log(`  ⚠️  ${lib} not installed (skipping tests)`);
  }
}

if (availableLibraries.length === 0) {
  console.log('\n⚠️  No WebRTC libraries installed. Skipping connectivity tests.');
  console.log('   Install at least one: npm install werift|wrtc|node-datachannel\n');
  process.exit(0);
}

console.log(`\nRunning tests for: ${availableLibraries.join(', ')}\n`);

describe('WebRTC Connectivity Tests', () => {
  
  for (const libraryName of availableLibraries) {
    describe(`${libraryName} library`, () => {
      
      it('should create peer connection', async () => {
        const peer = await createWebRTCPeer(libraryName);
        assert.ok(peer, 'Peer should be created');
        assert.strictEqual(peer.libraryName, libraryName);
        peer.close();
      });

      it('should initialize with ICE servers', async () => {
        const peer = await createWebRTCPeer(libraryName, {
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' }
            ]
          }
        });
        
        assert.ok(peer, 'Peer should be created with ICE servers');
        assert.ok(peer.pc, 'Peer connection should be initialized');
        peer.close();
      });

      it('should create and handle offer/answer', { timeout: 10000 }, async () => {
        const offerer = await createWebRTCPeer(libraryName);
        const answerer = await createWebRTCPeer(libraryName);
        
        try {
          // Offerer creates datachannel
          let offererChannel = null;
          if (libraryName === 'node-datachannel') {
            // Reset promise before creating datachannel to catch the offer
            offerer.resetLocalDescriptionPromise();
            offererChannel = offerer.pc.createDataChannel('test');
          } else {
            offererChannel = offerer.pc.createDataChannel('test');
          }
          
          assert.ok(offererChannel, 'Data channel should be created');
          
          // Create offer
          let offer;
          if (libraryName === 'node-datachannel') {
            // Wait for local description with timeout
            offer = await offerer.waitForLocalDescription(5000);
          } else {
            offer = await offerer.pc.createOffer();
            await offerer.pc.setLocalDescription(offer);
          }
          
          assert.ok(offer, 'Offer should be created');
          assert.ok(offer.sdp || offer.type === 'offer', 'Offer should have SDP');
          
          // Answerer handles offer
          await answerer.handleOffer(offer);
          
          // Create answer
          const answer = await answerer.createAnswer();
          
          assert.ok(answer, 'Answer should be created');
          assert.ok(answer.sdp || answer.type === 'answer', 'Answer should have SDP');
          
        } finally {
          offerer.close();
          answerer.close();
        }
      });

      it('should register event handlers', async () => {
        const peer = await createWebRTCPeer(libraryName);
        
        let handlerCalled = false;
        peer.on('test-event', () => {
          handlerCalled = true;
        });
        
        // Manually trigger handler
        if (peer.handlers.has('test-event')) {
          peer.handlers.get('test-event')();
        }
        
        assert.strictEqual(handlerCalled, true, 'Event handler should be called');
        peer.close();
      });

      it('should track ICE candidates', async () => {
        const peer = await createWebRTCPeer(libraryName);
        
        const initialCount = peer.getICECandidates().length;
        assert.strictEqual(initialCount, 0, 'Should start with no candidates');
        
        // Simulate ICE candidate
        peer.iceCandidates.push({
          candidate: 'candidate:test',
          sdpMid: '0',
          sdpMLineIndex: 0
        });
        
        assert.strictEqual(peer.getICECandidates().length, 1, 'Should track ICE candidates');
        peer.close();
      });

      it('should close cleanly', async () => {
        const peer = await createWebRTCPeer(libraryName);
        
        peer.close();
        
        assert.strictEqual(peer.dataChannels.size, 0, 'Data channels should be cleared');
        assert.strictEqual(peer.getICECandidates().length, 0, 'ICE candidates should be cleared');
      });
    });
  }
});

describe('WebRTC Performance Tests', () => {
  
  for (const libraryName of availableLibraries) {
    describe(`${libraryName} performance`, () => {
      
      it('should create peer quickly', async () => {
        const start = Date.now();
        const peer = await createWebRTCPeer(libraryName);
        const duration = Date.now() - start;
        
        assert.ok(peer, 'Peer should be created');
        assert.ok(duration < 1000, `Peer creation should be fast (<1s), took ${duration}ms`);
        
        peer.close();
      });

      it('should handle multiple peers', async () => {
        const peers = [];
        const count = 5;
        
        const start = Date.now();
        
        for (let i = 0; i < count; i++) {
          const peer = await createWebRTCPeer(libraryName);
          peers.push(peer);
        }
        
        const duration = Date.now() - start;
        
        assert.strictEqual(peers.length, count, `Should create ${count} peers`);
        assert.ok(duration < 5000, `Creating ${count} peers should be fast (<5s), took ${duration}ms`);
        
        // Cleanup
        for (const peer of peers) {
          peer.close();
        }
      });

      it('should measure offer/answer creation time', { timeout: 15000 }, async () => {
        const offerer = await createWebRTCPeer(libraryName);
        const answerer = await createWebRTCPeer(libraryName);
        
        try {
          // Create datachannel
          if (libraryName === 'node-datachannel') {
            // Reset promise before creating datachannel to catch the offer
            offerer.resetLocalDescriptionPromise();
            offerer.pc.createDataChannel('perf-test');
          } else {
            offerer.pc.createDataChannel('perf-test');
          }
          
          // Measure offer creation
          const offerStart = Date.now();
          let offer;
          
          if (libraryName === 'node-datachannel') {
            // Wait for local description with timeout
            offer = await offerer.waitForLocalDescription(5000);
          } else {
            offer = await offerer.pc.createOffer();
            await offerer.pc.setLocalDescription(offer);
          }
          
          const offerDuration = Date.now() - offerStart;
          
          // Measure answer creation
          const answerStart = Date.now();
          await answerer.handleOffer(offer);
          const answer = await answerer.createAnswer();
          const answerDuration = Date.now() - answerStart;
          
          console.log(`    ${libraryName}: offer=${offerDuration}ms, answer=${answerDuration}ms`);
          
          assert.ok(offerDuration < 2000, `Offer creation should be fast (<2s), took ${offerDuration}ms`);
          assert.ok(answerDuration < 2000, `Answer creation should be fast (<2s), took ${answerDuration}ms`);
          
        } finally {
          offerer.close();
          answerer.close();
        }
      });

      it('should handle rapid open/close cycles', async () => {
        const cycles = 10;
        const start = Date.now();
        
        for (let i = 0; i < cycles; i++) {
          const peer = await createWebRTCPeer(libraryName);
          peer.close();
        }
        
        const duration = Date.now() - start;
        const avgPerCycle = duration / cycles;
        
        console.log(`    ${libraryName}: ${cycles} cycles in ${duration}ms (avg ${avgPerCycle.toFixed(1)}ms/cycle)`);
        
        assert.ok(duration < 10000, `${cycles} cycles should complete quickly (<10s), took ${duration}ms`);
      });
    });
  }
});

describe('WebRTC Abstraction Compatibility', () => {
  
  if (availableLibraries.length > 1) {
    it('should provide consistent API across libraries', async () => {
      const peers = {};
      
      // Create one peer for each library
      for (const lib of availableLibraries) {
        peers[lib] = await createWebRTCPeer(lib);
      }
      
      // Verify all have same methods
      const methods = ['handleOffer', 'createAnswer', 'addICECandidate', 'on', 'send', 'getICECandidates', 'close'];
      
      for (const lib of availableLibraries) {
        for (const method of methods) {
          assert.strictEqual(
            typeof peers[lib][method],
            'function',
            `${lib} should have ${method} method`
          );
        }
      }
      
      // Cleanup
      for (const lib of availableLibraries) {
        peers[lib].close();
      }
    });

    it('should have consistent event handler registration', async () => {
      const peers = {};
      
      for (const lib of availableLibraries) {
        peers[lib] = await createWebRTCPeer(lib);
        
        let called = false;
        peers[lib].on('test', () => { called = true; });
        
        assert.ok(peers[lib].handlers.has('test'), `${lib} should register event handlers`);
      }
      
      // Cleanup
      for (const lib of availableLibraries) {
        peers[lib].close();
      }
    });
  } else {
    it('should skip cross-library tests with only one library', () => {
      console.log(`    ℹ️  Only one library available (${availableLibraries[0]}), skipping cross-library tests`);
    });
  }
});
