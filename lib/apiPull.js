'use strict';
// 2.0 · 从后端两个只读接口拉取数据
//  接口① stats?batchId       → 该批每个兑换码 + 兑换次数(redeemedCount)
//  接口② redemptions?code    → 某码每笔兑换明细(用户/IP/设备/时间)，翻页
// 拉取只写"待发布"(codes.pending)与明细表；正式上前台由 publish 错峰执行。
const { getDb, getSetting, setSetting, log } = require('./db');

// 只读密钥：优先环境变量（k8s Secret 注入），本地开发回落 config.adminReadKey
function readKey(config) {
  return (process.env.ADMIN_READ_KEY || (config && config.adminReadKey) || '').trim();
}
function baseUrl(config) {
  return (process.env.API_BASE_URL || (config && config.apiBaseUrl) || '').trim().replace(/\/$/, '');
}

async function apiGet(config, pathAndQuery) {
  const base = baseUrl(config);
  const key = readKey(config);
  if (!base) throw new Error('未配置接口地址 apiBaseUrl');
  if (!key) throw new Error('未配置只读密钥（环境变量 ADMIN_READ_KEY）');
  const res = await fetch(base + pathAndQuery, {
    headers: { 'X-Admin-Api-Key': key },
    signal: AbortSignal.timeout(20000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code !== 200) {
    const msg = body.message || `HTTP ${res.status}`;
    throw new Error(`接口返回异常：${msg}（${pathAndQuery}）`);
  }
  return body.data;
}

// 接口① 某批次的码 + 兑换次数（apiBaseUrl 已含 /api，故这里从 /pss 开始）
function pullStats(config, batchId) {
  return apiGet(config, `/pss/v1/admin/redeem-codes/stats?batchId=${encodeURIComponent(batchId)}`);
}

// 接口② 某码的全部兑换明细（自动翻页）
async function pullRedemptions(config, code) {
  const size = 1000;
  let page = 0;
  const rows = [];
  for (;;) {
    const d = await apiGet(config, `/pss/v1/admin/redeem-codes/redemptions?code=${encodeURIComponent(code)}&page=${page}&size=${size}`);
    for (const r of (d.redemptions || [])) {
      rows.push({
        user_id: String(r.redeemerUserId || ''),
        ip: r.loginIp || '',
        device: r.replicaId || '',
        redeemed_at: typeof r.redeemedAt === 'number' ? r.redeemedAt : null
      });
    }
    if ((page + 1) * size >= (d.totalRedemptions || 0)) break;
    page++;
  }
  return rows;
}

// 导入/刷新一批 batchId：写码池(pending=兑换次数) + 明细表。withDetail=false 时只拉①不拉②（快）
async function pullBatches(config, batchIds, { withDetail = true } = {}) {
  const db = getDb();
  const result = { ok: true, batches: [], errors: [] };
  const upCode = db.prepare(`
    INSERT INTO codes(code, batch_id, pending, max_redemptions, synced_at)
    VALUES(?,?,?,?,datetime('now','localtime'))
    ON CONFLICT(code) DO UPDATE SET
      batch_id=excluded.batch_id, pending=excluded.pending,
      max_redemptions=excluded.max_redemptions, synced_at=excluded.synced_at
  `);
  const delDetail = db.prepare('DELETE FROM redemptions WHERE code=?');
  const insDetail = db.prepare('INSERT OR REPLACE INTO redemptions(code,user_id,ip,device,redeemed_at) VALUES(?,?,?,?,?)');

  for (const batchId of batchIds) {
    try {
      const data = await pullStats(config, batchId);
      const codes = data.codes || [];
      db.exec('BEGIN');
      try {
        for (const c of codes) upCode.run(c.code, String(batchId), c.redeemedCount | 0, c.maxRedemptions | 0);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }

      let detailCodes = 0, detailRows = 0;
      if (withDetail) {
        for (const c of codes) {
          if ((c.redeemedCount | 0) <= 0) continue;
          try {
            const rows = await pullRedemptions(config, c.code);
            db.exec('BEGIN');
            try {
              delDetail.run(c.code);
              for (const r of rows) insDetail.run(c.code, r.user_id, r.ip, r.device, r.redeemed_at);
              db.exec('COMMIT');
            } catch (e) { db.exec('ROLLBACK'); throw e; }
            detailCodes++; detailRows += rows.length;
          } catch (e) {
            result.errors.push(`码 ${c.code} 明细拉取失败：${e.message}`);
          }
        }
      }
      result.batches.push({ batchId: String(batchId), totalCodes: data.totalCodes, totalRedemptions: data.totalRedemptions, detailCodes, detailRows });
    } catch (e) {
      result.ok = false;
      result.errors.push(`批次 ${batchId}：${e.message}`);
    }
  }
  return result;
}

module.exports = { pullStats, pullRedemptions, pullBatches, readKey, baseUrl };
