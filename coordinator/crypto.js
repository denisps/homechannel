import crypto from 'crypto';
import fs from 'fs';

/**
 * Crypto module for ECDSA, ECDH, and HMAC operations
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
 * Perform ECDH key exchange (for initial handshake)
 */
export function performECDH(privateKey, peerPublicKey) {
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
 * Encrypt data with AES-CTR (returns Buffer)
 */
export function encryptAES(data, key) {
  // Generate random IV (16 bytes for AES)
  const iv = crypto.randomBytes(16);
  
  // Create cipher
  const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
  
  // Encrypt data (JSON serialized)
  const dataBuffer = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  
  // Return IV + encrypted data as Buffer
  return Buffer.concat([iv, encrypted]);
}

/**
 * Decrypt data with AES-CTR (accepts Buffer)
 */
export function decryptAES(encryptedBuffer, key) {
  try {
    // Extract IV (first 16 bytes)
    const iv = encryptedBuffer.slice(0, 16);
    const encrypted = encryptedBuffer.slice(16);
    
    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
    
    // Decrypt
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    
    // Parse JSON
    return JSON.parse(decrypted.toString('utf8'));
  } catch (error) {
    throw new Error('Decryption failed: ' + error.message);
  }
}

/**
 * Encode binary registration message
 * Format: [pubKeyLen(2)][pubKey][timestamp(8)][challenge(16)][answerHash(32)][sigLen(2)][signature]
 */
export function encodeBinaryRegistration(serverPublicKey, timestamp, challenge, challengeAnswerHash, signature) {
  // Convert hex strings to buffers
  const pubKeyBuffer = Buffer.from(serverPublicKey, 'utf8');
  const challengeBuffer = Buffer.from(challenge, 'hex');
  const answerHashBuffer = Buffer.from(challengeAnswerHash, 'hex');
  const signatureBuffer = Buffer.from(signature, 'hex');
  
  // Create timestamp buffer (8 bytes, big endian)
  const timestampBuffer = Buffer.allocUnsafe(8);
  timestampBuffer.writeBigUInt64BE(BigInt(timestamp));
  
  // Create length prefixes (2 bytes each)
  const pubKeyLenBuffer = Buffer.allocUnsafe(2);
  pubKeyLenBuffer.writeUInt16BE(pubKeyBuffer.length);
  
  const sigLenBuffer = Buffer.allocUnsafe(2);
  sigLenBuffer.writeUInt16BE(signatureBuffer.length);
  
  // Concatenate all parts
  return Buffer.concat([
    pubKeyLenBuffer,
    pubKeyBuffer,
    timestampBuffer,
    challengeBuffer,
    answerHashBuffer,
    sigLenBuffer,
    signatureBuffer
  ]);
}

/**
 * Decode binary registration message
 * Format: [pubKeyLen(2)][pubKey][timestamp(8)][challenge(16)][answerHash(32)][sigLen(2)][signature]
 */
export function decodeBinaryRegistration(buffer) {
  let offset = 0;
  
  // Read public key length and data
  const pubKeyLen = buffer.readUInt16BE(offset);
  offset += 2;
  const serverPublicKey = buffer.slice(offset, offset + pubKeyLen).toString('utf8');
  offset += pubKeyLen;
  
  // Read timestamp
  const timestamp = Number(buffer.readBigUInt64BE(offset));
  offset += 8;
  
  // Read challenge (16 bytes)
  const challenge = buffer.slice(offset, offset + 16).toString('hex');
  offset += 16;
  
  // Read answer hash (32 bytes)
  const challengeAnswerHash = buffer.slice(offset, offset + 32).toString('hex');
  offset += 32;
  
  // Read signature length and data
  const sigLen = buffer.readUInt16BE(offset);
  offset += 2;
  const signature = buffer.slice(offset, offset + sigLen).toString('hex');
  offset += sigLen;
  
  return {
    serverPublicKey,
    timestamp,
    challenge,
    challengeAnswerHash,
    signature
  };
}
