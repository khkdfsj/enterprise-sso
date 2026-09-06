import { config } from './config.js';
import { publicUrl } from './public-url.js';

export const ADMIN_RECOVERY_COOKIE = 'esso_recovery';

export function adminRecoveryCookie(maxAge = 600) {
  const value = maxAge > 0 ? 'admin' : '';
  return `${ADMIN_RECOVERY_COOKIE}=${value}; Path=${publicUrl('/')}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
}

export function hasAdminRecoveryCookie(req) {
  return String(req.headers.cookie ?? '').split(';').some((part) => part.trim() === `${ADMIN_RECOVERY_COOKIE}=admin`);
}
