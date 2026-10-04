import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_MS = 10 * 60 * 1000;

function signature(payload, key) {
  return createHmac('sha256', key).update(`esso-logout-recovery-v1:${payload}`).digest('base64url');
}

export function createLogoutRecovery({ clientId, returnUri }, key, now = Date.now()) {
  if (!clientId || !key) return '';
  const payload = Buffer.from(JSON.stringify({ clientId, returnUri: returnUri || '', expires: now + MAX_AGE_MS })).toString('base64url');
  return `${payload}.${signature(payload, key)}`;
}

export function readLogoutRecovery(token, key, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096 || !key) return null;
  const [payload, suppliedSignature, extra] = token.split('.');
  if (!payload || !suppliedSignature || extra !== undefined) return null;
  const expected = signature(payload, key);
  if (suppliedSignature.length !== expected.length
      || !timingSafeEqual(Buffer.from(suppliedSignature), Buffer.from(expected))) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof value.clientId !== 'string' || !value.clientId
        || typeof value.returnUri !== 'string'
        || !Number.isFinite(value.expires) || value.expires < now || value.expires > now + MAX_AGE_MS) return null;
    if (value.returnUri && !/^https?:\/\//i.test(value.returnUri)) return null;
    return value;
  } catch {
    return null;
  }
}
