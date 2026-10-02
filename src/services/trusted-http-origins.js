import { isIP } from 'node:net';
import { config } from '../config.js';
import { pool } from '../db.js';

export function parseTrustedHttpOrigin(hostValue, portValue) {
  const host = String(hostValue ?? '').trim();
  const port = Number(String(portValue ?? '80').trim());
  if (isIP(host) !== 4 || host !== new URL(`http://${host}/`).hostname) {
    throw new Error('请填写单个 IPv4 地址，不包含协议、路径或网段。');
  }
  const octets = host.split('.').map(Number);
  if (octets[0] === 0 || octets[0] === 127 || octets[0] >= 224
      || (octets[0] === 169 && octets[1] === 254)) {
    throw new Error('该 IP 属于本机、链路本地或保留地址，不能登记。');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1 到 65535 的整数。');
  }
  return { host, port };
}

export async function isApprovedIntegrationUrl(url) {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  if (!config.production && ['127.0.0.1', 'localhost'].includes(url.hostname)) return true;
  if (config.internalHttpRedirectHosts.has(url.hostname)) return true;
  if (isIP(url.hostname) !== 4) return false;
  const port = Number(url.port || 80);
  const [rows] = await pool.execute(
    "SELECT 1 FROM trusted_http_origins WHERE host=? AND port=? AND status='active' LIMIT 1",
    [url.hostname, port],
  );
  return rows.length > 0;
}
