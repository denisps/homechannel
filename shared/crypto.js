import crypto from 'crypto';

/**
 * Shared crypto module for ECDSA, ECDH, and HMAC operations
 * Used by both coordinator and server
 * Note: Key loading moved to keys.js to separate file I/O concerns
 */

/**
 * Sign data with ECDSA private key
 */
export function signData(data, privateKey) {
  const sign = crypto.createSign('SHA256');
  sign.update(JSON.stringify(data));
  return sign.sign(privateKey, 'hex');
}

/**
 * Verify ECDSA signature
 */
export function verifySignature(data, signature, publicKey) {
  try {
    const verify = crypto.createVerify('SHA256');
    verify.update(JSON.stringify(data));
    return verify.verify(publicKey, signature, 'hex');
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
 * Generate ECDH key pair for key exchange
 */
export function generateECDHKeyPair() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey(),
    privateKey: ecdh.getPrivateKey(),
    ecdh
  };
}

/**
 * Compute ECDH shared secret
 */
export function computeECDHSecret(privateKey, peerPublicKey) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  return ecdh.computeSecret(peerPublicKey);
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
 * Sign binary data with ECDSA (for ECDH keys)
 */
export function signBinaryData(data, privateKey) {
  const sign = crypto.createSign('SHA256');
  sign.update(data);
  return sign.sign(privateKey);
}

/**
 * Verify ECDSA signature on binary data
 */
export function verifyBinarySignature(data, signature, publicKey) {
  try {
    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    return verify.verify(publicKey, signature);
  } catch (error) {
    return false;
  }
}

/**
 * Encode ECDH init message (Phase 1: Server → Coordinator)
 * Format: [ecdhPubKeyLen(1)][ecdhPubKey]
 * No ECDSA public key or signature - server identity revealed only after encryption
 */
export function encodeECDHInit(ecdhPublicKey) {
  const ecdhPubKeyBuffer = ecdhPublicKey; // Already a Buffer
  
  // Validate length fits in 1 byte (0-255)
  if (ecdhPubKeyBuffer.length > 255) throw new Error('ECDH public key too long');
  
  // Concatenate: length prefix + ECDH public key
  return Buffer.concat([
    Buffer.from([ecdhPubKeyBuffer.length]),
    ecdhPubKeyBuffer
  ]);
}

/**
 * Decode ECDH init message
 * Format: [ecdhPubKeyLen(1)][ecdhPubKey]
 */
export function decodeECDHInit(buffer) {
  let offset = 0;
  
  // Read ECDH public key
  const ecdhPubKeyLen = buffer.readUInt8(offset);
  offset += 1;
  const ecdhPublicKey = buffer.slice(offset, offset + ecdhPubKeyLen);
  
  return {
    ecdhPublicKey
  };
}

/**
 * Encode ECDH response message (Phase 2: Coordinator → Server)
 * Format: [ecdhPubKeyLen(1)][ecdhPubKey][encryptedData]
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
