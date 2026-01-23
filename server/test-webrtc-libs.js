#!/usr/bin/env node

/**
 * Test WebRTC library loading
 * Demonstrates dynamic loading and library detection
 */

import { loadWebRTCLibrary, createWebRTCPeer } from './webrtc.js';

const libraries = ['werift', 'wrtc', 'node-datachannel'];

console.log('Testing WebRTC library loading...\n');

for (const libraryName of libraries) {
  console.log(`Testing ${libraryName}:`);
  
  const library = await loadWebRTCLibrary(libraryName);
  
  if (library) {
    console.log(`  ✅ ${libraryName} loaded successfully`);
    
    // Try to create a peer
    try {
      const peer = await createWebRTCPeer(libraryName);
      console.log(`  ✅ WebRTCPeer created successfully`);
      peer.close();
    } catch (error) {
      console.log(`  ❌ Error creating peer: ${error.message}`);
    }
  } else {
    console.log(`  ⚠️  ${libraryName} not available (install with: npm install ${libraryName})`);
  }
  
  console.log('');
}

console.log('Test complete.');
