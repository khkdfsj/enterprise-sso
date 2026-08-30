import { config } from '../config.js';

let cachedToken;

function requireConfigured() {
  if (!config.wecom.corpId || !config.wecom.agentId || !config.wecom.corpSecret) {
    throw new Error('WeCom authentication is not configured');
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`WeCom HTTP ${response.status}`);
  const data = await response.json();
  if (data.errcode && data.errcode !== 0) throw new Error(`WeCom API error ${data.errcode}`);
  return data;
}

async function accessToken() {
  requireConfigured();
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
  url.searchParams.set('corpid', config.wecom.corpId);
  url.searchParams.set('corpsecret', config.wecom.corpSecret);
  const data = await fetchJson(url);
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(300, Number(data.expires_in ?? 7200)) * 1000,
  };
  return cachedToken.value;
}

export function buildWecomAuthorizeUrl(state) {
  requireConfigured();
  const callback = `${config.issuer}/wecom/callback`;
  const url = new URL('https://open.weixin.qq.com/connect/oauth2/authorize');
  url.searchParams.set('appid', config.wecom.corpId);
  url.searchParams.set('redirect_uri', callback);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.wecom.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('agentid', config.wecom.agentId);
  return `${url.toString()}#wechat_redirect`;
}

export async function resolveWecomUser(code) {
  const token = await accessToken();
  const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo');
  url.searchParams.set('access_token', token);
  url.searchParams.set('code', code);
  const data = await fetchJson(url);
  const userId = data.userid ?? data.UserId ?? data.UserID;
  if (!userId) throw new Error('WeCom response did not contain a user id');
  return String(userId);
}

