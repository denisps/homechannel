/**
 * Browser-compatible crypto utilities for HomeChannel client
 * Uses Web Crypto API instead of Node.js crypto module
 */

// Use globalThis.crypto which works in both browser and Node.js (18+)
const cryptoAPI = globalThis.crypto;

/**
 * Base64 decode that works in both browser and Node.js
 */
function base64Decode(str) {
  if (typeof atob !== 'undefined') {
    // Browser environment
    return atob(str);
  } else if (typeof Buffer !== 'undefined') {
    // Node.js environment
    return Buffer.from(str, 'base64').toString('binary');
  }
  throw new Error('No base64 decoder available');
}

/**
 * Convert PEM public key to CryptoKey for ECDSA verification
 */
async function importPublicKey(pemKey) {
  // Remove PEM header/footer and decode base64
  const pemContents = pemKey
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s/g, '');
  
  const binaryDer = Uint8Array.from(base64Decode(pemContents), c => c.charCodeAt(0));
  
  return await cryptoAPI.subtle.importKey(
    'spki',
    binaryDer,
    {
      name: 'ECDSA',
      namedCurve: 'P-256'
    },
    true,
    ['verify']
  );
}

/**
 * Verify ECDSA signature (browser version)
 */
export async function verifySignature(data, signature, publicKeyPem) {
  try {
    const publicKey = await importPublicKey(publicKeyPem);
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(JSON.stringify(data));
    const signatureBuffer = hexToBytes(signature);
    
    return await cryptoAPI.subtle.verify(
      {
        name: 'ECDSA',
        hash: 'SHA-256'
      },
      publicKey,
      signatureBuffer,
      dataBuffer
    );
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Hash challenge answer (browser version)
 */
export async function hashChallengeAnswer(challenge, password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(challenge + password);
  const hashBuffer = await cryptoAPI.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(hashBuffer));
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
