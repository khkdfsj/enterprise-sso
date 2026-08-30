import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';

const storageKey = createHash('sha256').update(config.oidcStorageKey).digest();

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  if (!/^(?:[0-9a-f]{2})+$/i.test(left) || !/^(?:[0-9a-f]{2})+$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function encryptJson(payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', storageKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: ciphertext.toString('base64url'),
  };
}

export function decryptJson(envelope) {
  if (!envelope || envelope.v !== 1) throw new Error('Unsupported encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', storageKey, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  const cleartext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(cleartext.toString('utf8'));
}
