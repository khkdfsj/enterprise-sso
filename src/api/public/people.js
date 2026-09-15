import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { pool } from '../../db.js';
import { apiError, apiSuccess } from '../response.js';

const router = express.Router();
const peoplePath = '/people';
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => apiError(res, 429, 'rate_limit_exceeded', '请求过于频繁，请稍后重试。'),
});

function publicHeaders(_req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  next();
}

router.options(peoplePath, publicHeaders, (_req, res) => res.sendStatus(204));

router.get(peoplePath, publicHeaders, limiter, async (req, res) => {
  if (Object.keys(req.query).length > 0) {
    return apiError(res, 400, 'unsupported_parameters', '该接口不接收查询参数。');
  }
  try {
    const [rows] = await pool.execute(
      `SELECT id AS user_id,display_name AS name
       FROM people
       WHERE status IN ('active','probation')
       ORDER BY id`,
    );
    return apiSuccess(res, {
      count: rows.length,
      people: rows.map((row) => ({ user_id: row.user_id, name: row.name })),
    });
  } catch (error) {
    console.error('public active people request failed', { requestId: req.apiRequestId, message: error.message });
    return apiError(res, 500, 'ESSO-PUBLIC-5000', '人员清单暂时无法读取。');
  }
});

export const publicPeopleRouter = router;
