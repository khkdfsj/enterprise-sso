import { config } from './config.js';

export function publicUrl(pathname = '/') {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${config.publicBasePath}${path}`;
}
