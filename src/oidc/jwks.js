import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPair, exportJWK } from 'jose';
import { config } from '../config.js';

export async function loadJwks() {
  try {
    const parsed = JSON.parse(await fs.readFile(config.jwksFile, 'utf8'));
    if (!Array.isArray(parsed.keys) || !parsed.keys.length) throw new Error('JWKS has no keys');
    return parsed;
  } catch (error) {
    if (config.production) throw new Error(`Production JWKS is unavailable: ${error.message}`);
    await fs.mkdir(path.dirname(config.jwksFile), { recursive: true });
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const key = await exportJWK(privateKey);
    Object.assign(key, { use: 'sig', alg: 'ES256', kid: `dev-${Date.now()}` });
    const jwks = { keys: [key] };
    await fs.writeFile(config.jwksFile, `${JSON.stringify(jwks, null, 2)}\n`, { mode: 0o600 });
    return jwks;
  }
}

