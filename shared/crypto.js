import crypto from 'crypto';

export const KEY_AGREEMENT_CURVES = new Set(['x25519', 'x448']);

export function normalizeKeyAgreementCurve(curve) {
  if (!curve) {
    return null;
  }

  const normalized = curve.toLowerCase();
  if (!KEY_AGREEMENT_CURVES.has(normalized)) {
    throw new Error(`Unsupported key agreement curve: ${curve}`);
  }

  return normalized;
}

/**
 * Shared crypto module for EdDSA, X25519/X448, and HMAC operations
 * Used by both coordinator and server
 * Note: Key loading moved to keys.js to separate file I/O concerns
 */

/**
 * Sign data with Ed25519/Ed448 private key
 */
export function signData(data, privateKey) {
  const dataBuffer = Buffer.from(JSON.stringify(data), 'utf8');
  return crypto.sign(null, dataBuffer, privateKey).toString('hex');
}

/**
 * Verify Ed25519/Ed448 signature
 */
export function verifySignature(data, signature, publicKey) {
  try {
    const dataBuffer = Buffer.from(JSON.stringify(data), 'utf8');
    const signatureBuffer = Buffer.from(signature, 'hex');
    return crypto.verify(null, dataBuffer, publicKey, signatureBuffer);
  } catch (error) {
    return false;
  }
}

/**
 * Create HMAC using shared secret
 */
export function createHMAC(data, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(data));
  return hmac.digest('hex');
}

/**
 * Verify HMAC
 */
export function verifyHMAC(data, hmacValue, secret) {
  try {
    const expected = createHMAC(data, secret);
    return crypto.timingSafeEqual(
      Buffer.from(hmacValue, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch (error) {
    return false;
  }
}

/**
 * Generate X25519/X448 key pair for key exchange
 */
export function generateECDHKeyPair(curve = 'x448') {
  const normalized = normalizeKeyAgreementCurve(curve) || 'x448';

  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync(normalized);
    return {
      publicKey: publicKey.export({ format: 'der', type: 'spki' }),
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }),
      curve: normalized,
      ecdh: null
    };
  } catch (error) {
    if (normalized === 'x448') {
      return generateECDHKeyPair('x25519');
    }
    throw error;
  }
}

/**
 * Compute X25519/X448 shared secret
 */
export function computeECDHSecret(privateKey, peerPublicKey, curve = 'x448') {
  const normalized = normalizeKeyAgreementCurve(curve) || 'x448';
  const privateKeyObj = crypto.createPrivateKey({
    key: privateKey,
    format: 'der',
    type: 'pkcs8'
  });
  const publicKeyObj = crypto.createPublicKey({
    key: peerPublicKey,
    format: 'der',
    type: 'spki'
  });

  return crypto.diffieHellman({ privateKey: privateKeyObj, publicKey: publicKeyObj });
}

/**
 * Generate random challenge
 */
export function generateChallenge() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Hash challenge answer
 */
export function hashChallengeAnswer(challenge, password) {
  const hash = crypto.createHash('sha256');
  hash.update(challenge + password);
  return hash.digest('hex');
}

/**
 * Derive AES key from expectedAnswer
 */
export function deriveAESKey(expectedAnswer) {
  // Use SHA-256 to derive a 256-bit key
  const hash = crypto.createHash('sha256');
  hash.update(expectedAnswer);
  return hash.digest();
}

/**
 * Encrypt data with AES-GCM (returns Buffer)
 * AES-GCM provides both encryption and authentication in one operation
 * Format: [iv (12 bytes)][authTag (16 bytes)][ciphertext]
 */
export function encryptAES(data, key) {
  // Generate random IV (12 bytes for GCM)
  const iv = crypto.randomBytes(12);
  
  // Create cipher with GCM mode
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  // Encrypt data (JSON serialized)
  const dataBuffer = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  
  // Get authentication tag (16 bytes)
  const authTag = cipher.getAuthTag();
  
  // Return IV + authTag + encrypted data as Buffer
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt data with AES-GCM (accepts Buffer)
 * If decryption succeeds, authentication is guaranteed
 * Throws error if data is tampered with or uses wrong key
 */
export function decryptAES(encryptedBuffer, key) {
  try {
    // Extract IV (first 12 bytes)
    const iv = encryptedBuffer.slice(0, 12);
    // Extract auth tag (next 16 bytes)
    const authTag = encryptedBuffer.slice(12, 28);
    // Rest is encrypted data
    const encrypted = encryptedBuffer.slice(28);
    
    // Create decipher with GCM mode
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    
    // Set auth tag for verification
    decipher.setAuthTag(authTag);
    
    // Decrypt and verify in one operation
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    
    // Parse JSON
    return JSON.parse(decrypted.toString('utf8'));
  } catch (error) {
    throw new Error('Decryption failed: ' + error.message);
  }
}

/**
 * Unwrap PEM public key to base64 (removes headers, footers, newlines)
 * For efficient network transmission and storage
 */
export function unwrapPublicKey(pemKey) {
  return pemKey
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s/g, '');
}

/**
 * Wrap base64 public key back to PEM format
 * For use with Node.js crypto operations
 */
export function wrapPublicKey(base64Key) {
  return `-----BEGIN PUBLIC KEY-----\n${base64Key}\n-----END PUBLIC KEY-----`;
}

/**
 * Sign binary data with Ed25519/Ed448 (for ECDH keys)
 */
export function signBinaryData(data, privateKey) {
  return crypto.sign(null, data, privateKey);
}

/**
 * Verify Ed25519/Ed448 signature on binary data
 */
export function verifyBinarySignature(data, signature, publicKey) {
  try {
    return crypto.verify(null, data, publicKey, signature);
  } catch (error) {
    return false;
  }
}

/**
 * Encode HELLO message (Phase 1: Server → Coordinator)
 * Format: [serverTag(4)]
 * 4-byte random tag to prevent DoS
 */
export function encodeHello(serverTag) {
  if (!Buffer.isBuffer(serverTag) || serverTag.length !== 4) {
    throw new Error('Server tag must be a 4-byte Buffer');
  }
  return serverTag;
}

/**
 * Decode HELLO message
 * Returns: { serverTag: Buffer }
 */
export function decodeHello(buffer) {
  if (buffer.length !== 4) {
    throw new Error('HELLO message must be exactly 4 bytes');
  }
  return {
    serverTag: buffer
  };
}

/**
 * Encode HELLO_ACK message (Phase 2: Coordinator → Server)
 * Format: [serverTag(4)][coordinatorTag(4)]
 * Coordinator echoes server's tag and sends its own
 */
export function encodeHelloAck(serverTag, coordinatorTag) {
  if (!Buffer.isBuffer(serverTag) || serverTag.length !== 4) {
    throw new Error('Server tag must be a 4-byte Buffer');
  }
  if (!Buffer.isBuffer(coordinatorTag) || coordinatorTag.length !== 4) {
    throw new Error('Coordinator tag must be a 4-byte Buffer');
  }
  return Buffer.concat([serverTag, coordinatorTag]);
}

/**
 * Decode HELLO_ACK message
 * Returns: { serverTag: Buffer, coordinatorTag: Buffer }
 */
export function decodeHelloAck(buffer) {
  if (buffer.length !== 8) {
    throw new Error('HELLO_ACK message must be exactly 8 bytes');
  }
  return {
    serverTag: buffer.slice(0, 4),
    coordinatorTag: buffer.slice(4, 8)
  };
}

/**
 * Encode ECDH init message (Phase 3: Server → Coordinator)
 * Format: [coordinatorTag(4)][ecdhPubKeyLen(1)][ecdhPubKey]
 * Public key is SPKI DER bytes for X25519/X448
 * Now includes coordinator's tag for verification before expensive key agreement
 */
export function encodeECDHInit(coordinatorTag, ecdhPublicKey) {
  if (!Buffer.isBuffer(coordinatorTag) || coordinatorTag.length !== 4) {
    throw new Error('Coordinator tag must be a 4-byte Buffer');
  }
  const ecdhPubKeyBuffer = ecdhPublicKey; // Already a Buffer
  
  // Validate length fits in 1 byte (0-255)
  if (ecdhPubKeyBuffer.length > 255) throw new Error('ECDH public key too long');
  
  // Concatenate: coordinator tag + length prefix + ECDH public key
  return Buffer.concat([
    coordinatorTag,
    Buffer.from([ecdhPubKeyBuffer.length]),
    ecdhPubKeyBuffer
  ]);
}

/**
 * Decode ECDH init message
 * Format: [coordinatorTag(4)][ecdhPubKeyLen(1)][ecdhPubKey]
 */
export function decodeECDHInit(buffer) {
  if (buffer.length < 5) {
    throw new Error('ECDH init message too short');
  }
  
  let offset = 0;
  
  // Read coordinator tag
  const coordinatorTag = buffer.slice(offset, offset + 4);
  offset += 4;
  
  // Read ECDH public key
  const ecdhPubKeyLen = buffer.readUInt8(offset);
  offset += 1;
  const ecdhPublicKey = buffer.slice(offset, offset + ecdhPubKeyLen);
  
  return {
    coordinatorTag,
    ecdhPublicKey
  };
}

/**
 * Encode ECDH response message (Phase 4: Coordinator → Server)
 * Format: [ecdhPubKeyLen(1)][ecdhPubKey][encryptedData]
 * Public key is SPKI DER bytes for X25519/X448
 * encryptedData contains AES-GCM encrypted {timestamp, signature}
 */
export function encodeECDHResponse(ecdhPublicKey, encryptedData) {
  const ecdhPubKeyBuffer = ecdhPublicKey; // Already a Buffer
  
  // Validate length fits in 1 byte
  if (ecdhPubKeyBuffer.length > 255) throw new Error('ECDH public key too long');
  
  return Buffer.concat([
    Buffer.from([ecdhPubKeyBuffer.length]),
    ecdhPubKeyBuffer,
    encryptedData
  ]);
}

/**
 * Decode ECDH response message
 * Format: [ecdhPubKeyLen(1)][ecdhPubKey][encryptedData]
 */
export function decodeECDHResponse(buffer) {
  let offset = 0;
  
  // Read ECDH public key
  const ecdhPubKeyLen = buffer.readUInt8(offset);
  offset += 1;
  const ecdhPublicKey = buffer.slice(offset, offset + ecdhPubKeyLen);
  offset += ecdhPubKeyLen;
  
  // Rest is encrypted data
  const encryptedData = buffer.slice(offset);
  
  return {
    ecdhPublicKey,
    encryptedData
  };
}
