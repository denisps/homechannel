#!/usr/bin/env node
/**
 * Demonstration of verbosity levels
 * Shows how UDP message size and source are logged at different verbosity levels
 */

import { UDPClient, UDPServer } from '../protocol.js';
import { generateECDSAKeyPair } from '../keys.js';

console.log('=== Verbosity Demo ===\n');

// Generate test keys
const serverKeys = { ...generateECDSAKeyPair(), password: 'test-password' };
const coordinatorKeys = { ...generateECDSAKeyPair(), password: 'coordinator-password' };

// Mock registry for coordinator
const mockRegistry = {
  register: (publicKey, ipPort, challenge, challengeAnswerHash) => {
    console.log(`[Registry] Registered server at ${ipPort}`);
  },
  updateTimestamp: (ipPort) => true,
  getExpectedAnswer: (ipPort) => null,
  updateChallenge: (ipPort, challenge, challengeAnswerHash) => {}
};

async function demo() {
  console.log('=== Testing Verbosity Levels ===\n');
  
  console.log('--- Test 1: verbosity=2 (verbose) ---');
  console.log('Starting UDP Server (Coordinator) with verbosity=2\n');
  
  const server = new UDPServer(mockRegistry, coordinatorKeys, {
    port: 13478,
    verbosity: 2  // Verbose mode - logs all messages with size and source
  });
  
  await server.start();
  await new Promise(resolve => setTimeout(resolve, 100));
  
  console.log('\nStarting UDP Client (Server) with verbosity=2\n');
  
  const client = new UDPClient('127.0.0.1', 13478, serverKeys, {
    verbosity: 2,  // Verbose mode - logs all messages with size and source
    coordinatorPublicKey: coordinatorKeys.publicKey
  });
  
  // Wait for registration to complete
  await new Promise((resolve) => {
    client.on('registered', () => {
      console.log('[Test] Client registration complete\n');
      resolve();
    });
    client.start().catch(console.error);
  });
  
  // Wait to see any additional messages
  await new Promise(resolve => setTimeout(resolve, 300));
  
  console.log('\n--- Cleanup ---');
  await client.stop();
  await server.stop();
  
  console.log('\n=== Demo Complete ===');
  console.log('\nNote: With verbosity=2, you should see:');
  console.log('  - "[UDP Server] Received X bytes from IP:port" for coordinator');
  console.log('  - "[UDP Client] Received X bytes from IP:port" for server');
  console.log('  - Message type names (hello, hello_ack, etc.)');
  console.log('\nVerbosity levels:');
  console.log('  0 = Silent (errors only)');
  console.log('  1 = Normal (important events like registration)');
  console.log('  2 = Verbose (all messages with size and source IP:port)');
}

demo().catch(console.error);
