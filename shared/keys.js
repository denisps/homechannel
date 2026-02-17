import fs from 'fs';
import crypto from 'crypto';

/**
 * Key management utilities for Ed25519/Ed448 keys
 * Separated from crypto.js to isolate file I/O concerns
 */

export const SIGNATURE_ALGORITHMS = new Set(['ed25519', 'ed448']);

export function normalizeSignatureAlgorithm(algorithm) {
  if (!algorithm) {
    return null;
  }

  const normalized = algorithm.toLowerCase();
  if (!SIGNATURE_ALGORITHMS.has(normalized)) {
    throw new Error(`Unsupported signature algorithm: ${algorithm}`);
  }

  return normalized;
}

export function detectSignatureAlgorithm(publicKeyPem) {
  try {
    const publicKey = crypto.createPublicKey(publicKeyPem);
    return publicKey.asymmetricKeyType;
  } catch (error) {
    return null;
  }
}

/**
 * Generate Ed25519/Ed448 key pair
 */
export function generateSigningKeyPair(signatureAlgorithm = 'ed448') {
  const normalized = normalizeSignatureAlgorithm(signatureAlgorithm) || 'ed448';
  return {
    ...crypto.generateKeyPairSync(normalized, {
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
    }),
    signatureAlgorithm: normalized
  };
}

/**
 * Load Ed25519/Ed448 keys from files
 * Returns null if files don't exist, throws on read errors
 */
export async function loadKeys(privateKeyPath, publicKeyPath) {
  try {
    await Promise.all([
      fs.promises.access(privateKeyPath),
      fs.promises.access(publicKeyPath)
    ]);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to load keys: ${error.message}`);
  }

  try {
    const [privateKey, publicKey] = await Promise.all([
      fs.promises.readFile(privateKeyPath, 'utf8'),
      fs.promises.readFile(publicKeyPath, 'utf8')
    ]);
    return {
      privateKey,
      publicKey,
      signatureAlgorithm: detectSignatureAlgorithm(publicKey)
    };
  } catch (error) {
    throw new Error(`Failed to load keys: ${error.message}`);
  }
}

/**
 * Save Ed25519/Ed448 keys to files
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

/**
 * Load TLS certificates from files
 */
export async function loadTLSCertificates(certPath, keyPath) {
  if (!certPath || !keyPath) {
    throw new Error('TLS certificate and key paths are required');
  }

  try {
    const [cert, key] = await Promise.all([
      fs.promises.readFile(certPath, 'utf8'),
      fs.promises.readFile(keyPath, 'utf8')
    ]);

    return { cert, key };
  } catch (error) {
    throw new Error(`Failed to load TLS certificates: ${error.message}`);
  }
}


