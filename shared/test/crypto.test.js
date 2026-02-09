import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  generateECDHKeyPair,
  computeECDHSecret,
  deriveAESKey,
  encryptAES,
  decryptAES,
  signBinaryData,
  verifyBinarySignature,
  encodeHello,
  decodeHello,
  encodeHelloAck,
  decodeHelloAck,
  encodeECDHInit,
  encodeECDHResponse,
  decodeECDHInit,
  decodeECDHResponse,
  generateChallenge,
  hashChallengeAnswer
} from '../crypto.js';

import { generateSigningKeyPair } from '../keys.js';

import {
  PROTOCOL_VERSION,
  MESSAGE_TYPES,
  buildUDPMessage,
  parseUDPMessage
} from '../protocol.js';

describe('shared crypto utilities', () => {
  test('challenge answer is deterministic', () => {
    const challenge = generateChallenge();
    const password = 'test-password';
    const answer1 = hashChallengeAnswer(challenge, password);
    const answer2 = hashChallengeAnswer(challenge, password);
    assert.strictEqual(answer1, answer2);
  });

  test('AES-GCM encrypt/decrypt roundtrip', () => {
    const key = deriveAESKey('test-expected-answer');
    const data = { type: 'test', value: 123 };
    const encrypted = encryptAES(data, key);
    const decrypted = decryptAES(encrypted, key);
    assert.deepStrictEqual(decrypted, data);
  });

  test('AES-GCM detects tampering', () => {
    const key = deriveAESKey('test-expected-answer');
    const data = { type: 'test', value: 123 };
    const encrypted = encryptAES(data, key);
    
    // Tamper with the ciphertext
    encrypted[30] ^= 0xFF;
    
    assert.throws(() => decryptAES(encrypted, key));
  });

  test('AES-GCM detects wrong key', () => {
    const key1 = deriveAESKey('test-expected-answer-1');
    const key2 = deriveAESKey('test-expected-answer-2');
    const data = { type: 'test', value: 123 };
    const encrypted = encryptAES(data, key1);
    
    assert.throws(() => decryptAES(encrypted, key2));
  });

  test('ECDH shared secret matches on both sides', () => {
    const ecdh1 = generateECDHKeyPair();
    const ecdh2 = generateECDHKeyPair();
    const secret1 = computeECDHSecret(ecdh1.privateKey, ecdh2.publicKey, ecdh1.curve);
    const secret2 = computeECDHSecret(ecdh2.privateKey, ecdh1.publicKey, ecdh2.curve);
    assert.deepStrictEqual(secret1, secret2);
  });

  test('binary signatures verify correctly', () => {
    const keys = generateSigningKeyPair();
    const data = Buffer.from('test data');
    const signature = signBinaryData(data, keys.privateKey);
    assert.strictEqual(verifyBinarySignature(data, signature, keys.publicKey), true);
  });

  test('binary signatures fail on tampering', () => {
    const keys = generateSigningKeyPair();
    const data = Buffer.from('test data');
    const wrongData = Buffer.from('wrong data');
    const signature = signBinaryData(data, keys.privateKey);
    assert.strictEqual(verifyBinarySignature(wrongData, signature, keys.publicKey), false);
  });
});

describe('shared protocol helpers', () => {
  test('encodes and decodes HELLO payload', async () => {
    const crypto = await import('crypto');
    const serverTag = crypto.default.randomBytes(4);
    const encoded = encodeHello(serverTag);
    assert.ok(Buffer.isBuffer(encoded));
    assert.strictEqual(encoded.length, 4);
    const decoded = decodeHello(encoded);
    assert.deepStrictEqual(decoded.serverTag, serverTag);
  });

  test('encodes and decodes HELLO_ACK payload', async () => {
    const crypto = await import('crypto');
    const serverTag = crypto.default.randomBytes(4);
    const coordinatorTag = crypto.default.randomBytes(4);
    const encoded = encodeHelloAck(serverTag, coordinatorTag);
    assert.ok(Buffer.isBuffer(encoded));
    assert.strictEqual(encoded.length, 8);
    const decoded = decodeHelloAck(encoded);
    assert.deepStrictEqual(decoded.serverTag, serverTag);
    assert.deepStrictEqual(decoded.coordinatorTag, coordinatorTag);
  });

  test('encodes and decodes ECDH init payload', async () => {
    const crypto = await import('crypto');
    const coordinatorTag = crypto.default.randomBytes(4);
    const ecdh = generateECDHKeyPair();
    const encoded = encodeECDHInit(coordinatorTag, ecdh.publicKey);
    assert.ok(Buffer.isBuffer(encoded));
    const decoded = decodeECDHInit(encoded);
    assert.deepStrictEqual(decoded.coordinatorTag, coordinatorTag);
    assert.deepStrictEqual(decoded.ecdhPublicKey, ecdh.publicKey);
  });

  test('encodes and decodes ECDH response payload', () => {
    const ecdh = generateECDHKeyPair();
    const encryptedData = Buffer.from('deadbeef', 'hex');
    const encoded = encodeECDHResponse(ecdh.publicKey, encryptedData);
    const decoded = decodeECDHResponse(encoded);
    assert.deepStrictEqual(decoded.ecdhPublicKey, ecdh.publicKey);
    assert.deepStrictEqual(decoded.encryptedData, encryptedData);
  });

  test('builds and parses UDP message framing', () => {
    const payload = Buffer.from('hello');
    const msg = buildUDPMessage(MESSAGE_TYPES.PING, payload);
    const parsed = parseUDPMessage(msg);
    assert.strictEqual(parsed.messageType, MESSAGE_TYPES.PING);
    assert.deepStrictEqual(parsed.payload, payload);
  });

  test('rejects unsupported protocol version', () => {
    const payload = Buffer.from('hi');
    const msg = Buffer.concat([Buffer.from([PROTOCOL_VERSION + 1, MESSAGE_TYPES.PING]), payload]);
    assert.throws(() => parseUDPMessage(msg));
  });
});
