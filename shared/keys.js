import fs from 'fs';
import crypto from 'crypto';

/**
 * Key management utilities for ECDSA keys
 * Separated from crypto.js to isolate file I/O concerns
 */

/**
 * Generate ECDSA key pair
 */
export function generateECDSAKeyPair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1', // P-256
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });
}

/**
 * Load ECDSA keys from files
 * Returns null if files don't exist, throws on read errors
 */
export function loadKeys(privateKeyPath, publicKeyPath) {
  try {
    if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
      return null;
    }
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    const publicKey = fs.readFileSync(publicKeyPath, 'utf8');
    return { privateKey, publicKey };
  } catch (error) {
    throw new Error(`Failed to load keys: ${error.message}`);
  }
}

/**
 * Save ECDSA keys to files
 * Creates directory structure if needed
 */
export function saveKeys(privateKeyPath, publicKeyPath, keys) {
  // Create keys directory if it doesn't exist
  const keysDir = privateKeyPath.substring(0, privateKeyPath.lastIndexOf('/'));
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
  }
  
  // Save keys with proper permissions (600 for private key)
  fs.writeFileSync(privateKeyPath, keys.privateKey, { mode: 0o600 });
  fs.writeFileSync(publicKeyPath, keys.publicKey);
}


