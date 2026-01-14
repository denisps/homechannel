import fs from 'fs';
import crypto from 'crypto';

/**
 * Key management utilities for ECDSA keys
 * Separated from crypto.js to isolate file I/O concerns
 */

/**
 * Load ECDSA keys from files
 */
export function loadKeys(privateKeyPath, publicKeyPath) {
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  const publicKey = fs.readFileSync(publicKeyPath, 'utf8');
  return { privateKey, publicKey };
}

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
