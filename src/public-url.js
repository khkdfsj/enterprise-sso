import { config } from './config.js';

const ASSET_VERSION = '0.6.1';

export function publicUrl(pathname = '/') {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = `${config.publicBasePath}${path}`;
  return path.startsWith('/assets/') ? `${url}?v=${ASSET_VERSION}` : url;
}
