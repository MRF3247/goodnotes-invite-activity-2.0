'use strict';
// CC（飞书 + Claude Code）专用接口：与后台登录解耦，统一用一把 X-Ingest-Key。
// 权限仅限“灌邀请码 / 读报名对应关系 / 写净人数刷榜”，碰不到后台设置与隐私，泄露影响可控。
const { getDb, log } = require('../lib/db');
const { readJson, send } = require('../lib/util');
const { ingestScores } = require('../lib/snapshot');

function authed(req, config) {
  const key = process.env.INGEST_KEY || config.ingestKey || '';
  if (!key) return false; // 未配置密钥时一律拒绝，避免裸奔
  const got = req.headers['x-ingest-key'] || '';
  return got.length === key.length && got === key;
}

async function handle(req, res, url, config) {
  if (!authed(req, config)) return send(res, 401, { ok: false, msg: 'X-Ingest-Key 无效' });
  const db = getDb();

  // ① 灌邀请码：CC 把表A的兑换码按顺序推进码池（幂等，重复推已存在的码自动跳过）
  //    body: { codes: ["CODE1", ...] } 或 [{ code, batchId, validTo, maxRedemptions }, ...]
  if (url.pathname === '/api/ingest/codes' && req.method === 'POST') {
    const body = await readJson(req);
    const list = Array.isArray(body) ? body : (body.codes || []);
    if (!Array.isArray(list) || !list.length) return send(res, 400, { ok: false, msg: 'codes 不能为空' });
    const ins = db.prepare(`INSERT OR IGNORE INTO codes(code, batch_id, valid_to, max_redemptions) VALUES(?,?,?,?)`);
    let added = 0, dup = 0;
    db.exec('BEGIN');
    try {
      for (const item of list) {
        const code = String(typeof item === 'string' ? item : (item.code || '')).trim();
        if (!code) continue;
        const batchId = typeof item === 'object' ? (item.batchId || item.batch_id || null) : null;
        const validTo = typeof item === 'object' ? (item.validTo || item.valid_to || null) : null;
        const maxR = typeof item === 'object' && item.maxRedemptions != null ? parseInt(item.maxRedemptions, 10) : null;
        const r = ins.run(code, batchId, validTo, Number.isFinite(maxR) ? maxR : null);
        if (r.changes > 0) added += 1; else dup += 1;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    log('ingest_codes', `CC 灌入邀请码：新增 ${added}，已存在 ${dup}`);
    return send(res, 200, { ok: true, added, duplicated: dup, total: added + dup });
  }

  // ② 导出报名用户↔邀请码对应关系：CC 读它去回填表B（报名用户uid / 小红书号）
  if (url.pathname === '/api/ingest/participants' && req.method === 'GET') {
    const rows = db.prepare(`
      SELECT uid, xhs_id AS xhs, nickname, code, created_at
      FROM participants WHERE code IS NOT NULL ORDER BY id
    `).all();
    return send(res, 200, { ok: true, count: rows.length, participants: rows });
  }

  // ③ 写净人数：CC 把风控清洗后的“码→净邀请人数”推进来，错峰后刷新公开榜
  //    body: { scores: { "CODE1": 12, ... } }
  if (url.pathname === '/api/ingest/scores' && req.method === 'POST') {
    const body = await readJson(req);
    const scores = body.scores || body;
    if (!scores || typeof scores !== 'object' || Array.isArray(scores) || !Object.keys(scores).length)
      return send(res, 400, { ok: false, msg: 'scores 需为 { 邀请码: 净人数 } 对象' });
    const r = ingestScores(scores);
    return send(res, 200, { ok: true, ...r });
  }

  return false; // 未匹配
}

module.exports = { handle };
