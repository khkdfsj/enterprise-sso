import { hash, verify } from '@node-rs/argon2';
import { config } from '../config.js';

const options = {
  memoryCost: 19456,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
  secret: Buffer.from(config.passwordPepper, 'utf8'),
};

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    throw new Error('Password must contain 6 to 200 characters');
  }
  return hash(password, options);
}

export async function verifyPassword(encoded, password) {
  if (typeof encoded !== 'string' || typeof password !== 'string' || password.length > 200) return false;
  try {
    return await verify(encoded, password, options);
  } catch {
    return false;
  }
}
