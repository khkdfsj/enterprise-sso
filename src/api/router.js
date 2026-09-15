import express from 'express';
import { agentRouter } from '../agent/router.js';
import { integrationTestsRouter } from '../integration-tests/router.js';
import { publicPeopleRouter } from './public/people.js';
import { provisioningApiRouter } from '../provisioning/router.js';
import { apiError, apiRequestContext } from './response.js';

const router = express.Router();

router.use(apiRequestContext);
router.use('/v1/public', publicPeopleRouter);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, private');
  next();
});
router.use('/v1/agent', agentRouter);
router.use('/v1/registrations', provisioningApiRouter);
router.use('/v1/integration-tests', integrationTestsRouter);
router.use((_req, res) => apiError(res, 404, 'endpoint_not_found', 'API 接口不存在。'));
router.use((error, req, res, _next) => {
  if (res.headersSent) return;
  if (error?.type === 'entity.parse.failed') {
    return apiError(res, 400, 'invalid_json', '请求体不是合法 JSON。');
  }
  console.error('api request failed', {
    requestId: req.apiRequestId,
    path: req.path,
    message: error?.message
  });
  return apiError(res, 500, 'ESSO-API-5000', 'API 请求处理失败。');
});

export const apiRouter = router;
