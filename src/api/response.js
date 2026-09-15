import { randomUUID } from 'node:crypto';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._@/-]{7,159}$/;

export function apiRequestContext(req, res, next) {
  const supplied = String(req.get('x-request-id') ?? '').trim();
  const requestId = REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
  req.apiRequestId = requestId;
  res.set('X-Request-ID', requestId);
  next();
}

export function apiSuccess(res, data, status = 200) {
  return res.status(status).json({ ...data, ok: true, request_id: res.req.apiRequestId });
}

export function apiError(res, status, code, message) {
  return res.status(status).json({ ok: false, request_id: res.req.apiRequestId, error: code, message });
}
