import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * TLS certificate utilities for HomeChannel
 * 
 * Provides self-signed certificate generation for development/testing.
 * For production, always use certificates from a trusted CA (e.g., Let's Encrypt).
 */

/**
 * Generate a self-signed certificate using OpenSSL
 * @param {Object} options - Certificate options
 * @param {string} options.commonName - Common Name (CN) for the certificate
 * @param {number} options.days - Validity period in days (default: 365)
 * @param {string} options.outputDir - Directory to save certificate files (optional)
 * @returns {Object} - { cert, key, certPath, keyPath } - PEM-encoded certificate and key
 */
export function generateSelfSignedCertificate(options = {}) {
  const commonName = options.commonName || 'localhost';
  const days = options.days || 365;
  
  // Create temporary directory for certificate generation
  const tmpDir = options.outputDir || fs.mkdtempSync(path.join(os.tmpdir(), 'homechannel-tls-'));
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');
  
  try {
    // Generate certificate using OpenSSL (available on most systems)
    // This creates both the private key and self-signed certificate
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days ${days} -nodes -subj "/CN=${commonName}" 2>/dev/null`, {
      stdio: 'pipe'
    });
    
    const key = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(certPath, 'utf8');
    
    // Clean up temp files if outputDir wasn't specified
    if (!options.outputDir) {
      fs.unlinkSync(keyPath);
      fs.unlinkSync(certPath);
      fs.rmdirSync(tmpDir);
    }
    
    return { cert, key, certPath: options.outputDir ? certPath : null, keyPath: options.outputDir ? keyPath : null };
  } catch (error) {
    // Clean up on error
    try {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      if (fs.existsSync(certPath)) fs.unlinkSync(certPath);
      if (!options.outputDir && fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
    } catch (cleanupErr) {
      // Ignore cleanup errors
    }
    
    throw new Error(`Failed to generate self-signed certificate: ${error.message}. Make sure OpenSSL is installed.`);
  }
}

/**
 * Generate a self-signed certificate in memory (fallback when OpenSSL not available)
 * Uses Node.js crypto module - may not work with all TLS implementations
 * @returns {Object} - { cert, key } - PEM-encoded certificate and key
 */
export function generateSelfSignedCertificateInMemory() {
  // Generate RSA key pair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  
  // Note: Node.js crypto doesn't have built-in X.509 certificate generation
  // For a proper implementation, you'd need node-forge or similar library
  // This fallback returns the keys but the cert won't be valid for TLS
  console.warn('In-memory certificate generation not fully supported - use OpenSSL or provide certificates');
  
  return { cert: publicKey, key: privateKey };
}

/**
 * Check if OpenSSL is available on the system
 * @returns {boolean} - true if OpenSSL is available
 */
export function isOpenSSLAvailable() {
  try {
    execSync('openssl version', { stdio: 'pipe' });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Load TLS certificates from files
 * @param {string} certPath - Path to certificate file
 * @param {string} keyPath - Path to private key file
 * @returns {Object} - { cert, key } - PEM-encoded certificate and key
 */
export function loadCertificates(certPath, keyPath) {
  if (!fs.existsSync(certPath)) {
    throw new Error(`Certificate file not found: ${certPath}`);
  }
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Private key file not found: ${keyPath}`);
  }
  
  return {
    cert: fs.readFileSync(certPath, 'utf8'),
    key: fs.readFileSync(keyPath, 'utf8')
  };
}

/**
 * Save TLS certificates to files
 * @param {string} certPath - Path to save certificate
 * @param {string} keyPath - Path to save private key
 * @param {Object} certs - { cert, key } - PEM-encoded certificate and key
 */
export function saveCertificates(certPath, keyPath, certs) {
  // Create directory if it doesn't exist
  const certDir = path.dirname(certPath);
  const keyDir = path.dirname(keyPath);
  
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }
  if (!fs.existsSync(keyDir)) {
    fs.mkdirSync(keyDir, { recursive: true });
  }
  
  fs.writeFileSync(certPath, certs.cert);
  fs.writeFileSync(keyPath, certs.key, { mode: 0o600 }); // Restrict private key permissions
}
