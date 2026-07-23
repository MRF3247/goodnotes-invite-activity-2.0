'use strict';
// 风控审核：导入后端每日两张表（兑换明细/用户设备），生成风控报告，
// 人工剔除违规用户后计算净积分并发布榜单
const { getDb, getSetting, log } = require('./db');
const { parseCsv } = require('./sync');

function isHeaderRow(fields) {
  const first = String(fields[0] || '').toLowerCase();
  return first === 'code' || first === 'userid' || first === '邀请码' || first === '兑换码';
}

// 表1：兑换明细（code, userId），全量覆盖导入
function importRedemptions(csvText) {
  const db = getDb();
  const rows = parseCsv(csvText).filter(r => r[0] && !isHeaderRow(r));
  if (!rows.length) return { ok: false, msg: '没有解析到有效数据行' };
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM redemptions');
    const ins = db.prepare('INSERT INTO redemptions(code, user_id) VALUES(?,?)');
    for (const [code, userId] of rows) {
      if (code && userId) ins.run(String(code).trim(), String(userId).trim());
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const stat = db.prepare('SELECT COUNT(*) rows, COUNT(DISTINCT code) codes, COUNT(DISTINCT user_id) users FROM redemptions').get();
  log('risk_import', `导入兑换明细表：${stat.rows} 行，涉及 ${stat.codes} 个邀请码、${stat.users} 个UID`);
  return { ok: true, ...stat };
}

// 表2：用户设备（userId, ip, deviceId），全量覆盖导入
function importDevices(csvText) {
  const db = getDb();
  const rows = parseCsv(csvText).filter(r => r[0] && !isHeaderRow(r));
  if (!rows.length) return { ok: false, msg: '没有解析到有效数据行' };
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM user_devices');
    const ins = db.prepare('INSERT INTO user_devices(user_id, ip, device) VALUES(?,?,?)');
    for (const [userId, ip, device] of rows) {
      if (userId) ins.run(String(userId).trim(), String(ip || '').trim(), String(device || '').trim());
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const stat = db.prepare('SELECT COUNT(*) rows, COUNT(DISTINCT user_id) users, COUNT(DISTINCT ip) ips, COUNT(DISTINCT device) devices FROM user_devices').get();
  log('risk_import', `导入用户设备表：${stat.rows} 行，涉及 ${stat.users} 个UID、${stat.ips} 个IP、${stat.devices} 个设备`);
  return { ok: true, ...stat };
}

// 聚集分析：按设备或IP分组，统计参与兑换的不同UID数
function clusters(db, field, threshold) {
  const groups = db.prepare(`
    SELECT d.${field} AS k, COUNT(DISTINCT r.user_id) AS c
    FROM redemptions r JOIN user_devices d ON d.user_id = r.user_id
    WHERE d.${field} != ''
    GROUP BY d.${field} HAVING c >= ? ORDER BY c DESC LIMIT 50
  `).all(threshold);
  const detail = db.prepare(`
    SELECT DISTINCT r.user_id, r.code, p.nickname
    FROM redemptions r
    JOIN user_devices d ON d.user_id = r.user_id
    LEFT JOIN codes c ON c.code = r.code
    LEFT JOIN participants p ON p.id = c.assigned_to
    WHERE d.${field} = ? LIMIT 100
  `);
  return groups.map(g => ({ key: g.k, userCount: g.c, members: detail.all(g.k) }));
}

function riskReport() {
  const db = getDb();
  const stat = db.prepare('SELECT COUNT(*) rows, COUNT(DISTINCT code) codes, COUNT(DISTINCT user_id) users FROM redemptions').get();
  if (!stat.rows) return { ok: false, msg: '请先导入兑换明细表' };
  const hasDevices = db.prepare('SELECT COUNT(*) c FROM user_devices').get().c > 0;
  // 阈值为0表示该维度不预警
  const devMin = parseInt(getSetting('risk_device_min'), 10) || 0;
  const ipMin = parseInt(getSetting('risk_ip_min'), 10) || 0;

  // 同一UID出现多次/多个码（按规则新用户只能兑换一次）
  const dupUsers = db.prepare(`
    SELECT r.user_id, COUNT(*) times, COUNT(DISTINCT r.code) codes,
           GROUP_CONCAT(DISTINCT r.code) code_list
    FROM redemptions r GROUP BY r.user_id HAVING times > 1 ORDER BY times DESC LIMIT 100
  `).all();

  const excluded = db.prepare('SELECT user_id, reason, created_at FROM excluded_users ORDER BY created_at DESC').all();

  return {
    ok: true,
    stat, hasDevices,
    thresholds: { device: devMin, ip: ipMin },
    deviceClusters: (hasDevices && devMin > 0) ? clusters(db, 'device', devMin) : [],
    ipClusters: (hasDevices && ipMin > 0) ? clusters(db, 'ip', ipMin) : [],
    dupUsers,
    excluded
  };
}

// 标记/恢复违规UID（被标记者的兑换不计入任何邀请码的积分）
function excludeUsers(userIds, reason) {
  const db = getDb();
  const ins = db.prepare('INSERT OR REPLACE INTO excluded_users(user_id, reason) VALUES(?,?)');
  let n = 0;
  for (const u of userIds) {
    const id = String(u).trim();
    if (id) { ins.run(id, reason); n++; }
  }
  log('risk_exclude', `标记 ${n} 个违规UID，原因：${reason}`);
  return n;
}

function restoreUser(userId) {
  const db = getDb();
  const r = db.prepare('DELETE FROM excluded_users WHERE user_id=?').run(String(userId).trim());
  if (r.changes) log('risk_restore', `恢复UID ${userId} 的兑换计分`);
  return r.changes > 0;
}

// 按剔除后的净数据计算每个邀请码的邀请人数（覆盖 activations），供发布榜单
function applyScores() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) c FROM redemptions').get().c;
  if (!total) return { ok: false, msg: '兑换明细表为空，请先导入表1' };
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE codes SET
        activations = (
          SELECT COUNT(DISTINCT r.user_id) FROM redemptions r
          WHERE r.code = codes.code
            AND r.user_id NOT IN (SELECT user_id FROM excluded_users)
        ),
        synced_at = datetime('now','localtime')
    `).run();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const excludedCount = db.prepare('SELECT COUNT(*) c FROM excluded_users').get().c;
  const sum = db.prepare('SELECT COALESCE(SUM(activations),0) s FROM codes').get().s;
  log('risk_publish', `按审核后数据计算邀请人数：净邀请合计 ${sum}，已剔除 ${excludedCount} 个违规UID`);
  return { ok: true, totalScore: sum, excludedCount };
}

// ===== 2.0 后台兑换榜 + 违规预警（用接口②明细表 redemptions.ip/device 直接算）=====
// 可疑 IP/设备：被 ≥ 阈值 个不同 UID 使用（跨账号复用 → 刷码信号）
function suspiciousSets(devMin, ipMin) {
  const db = getDb();
  const ips = ipMin > 0
    ? db.prepare("SELECT ip FROM redemptions WHERE ip!='' GROUP BY ip HAVING COUNT(DISTINCT user_id) >= ?").all(ipMin).map(r => r.ip)
    : [];
  const devs = devMin > 0
    ? db.prepare("SELECT device FROM redemptions WHERE device!='' GROUP BY device HAVING COUNT(DISTINCT user_id) >= ?").all(devMin).map(r => r.device)
    : [];
  return { ips: new Set(ips), devs: new Set(devs) };
}

// 后台兑换榜：按（待发布兑换数 + 人工修正）排序，逐码标注违规命中数
function codeLeaderboard() {
  const db = getDb();
  const devMin = parseInt(getSetting('risk_device_min'), 10) || 0;
  const ipMin = parseInt(getSetting('risk_ip_min'), 10) || 0;
  const { ips, devs } = suspiciousSets(devMin, ipMin);
  const codes = db.prepare(`
    SELECT c.code, c.batch_id,
           COALESCE(c.pending, c.activations) AS redeemed,
           c.activations AS live, c.manual_delta, p.nickname
    FROM codes c LEFT JOIN participants p ON p.id = c.assigned_to
    WHERE COALESCE(c.pending, c.activations) > 0 OR c.manual_delta != 0
    ORDER BY (COALESCE(c.pending, c.activations) + c.manual_delta) DESC, c.code
    LIMIT 500
  `).all();
  const detailStmt = db.prepare('SELECT ip, device FROM redemptions WHERE code=?');
  const rows = codes.map((c, i) => {
    let viol = 0; const badIps = new Set(), badDevs = new Set();
    for (const r of detailStmt.all(c.code)) {
      if (r.ip && ips.has(r.ip)) { viol++; badIps.add(r.ip); }
      else if (r.device && devs.has(r.device)) { viol++; badDevs.add(r.device); }
    }
    return {
      rank: i + 1, code: c.code, batch_id: c.batch_id, nickname: c.nickname || '',
      redeemed: c.redeemed, manual_delta: c.manual_delta, score: c.redeemed + c.manual_delta,
      viol, badIps: [...badIps].slice(0, 5), badDevs: [...badDevs].slice(0, 5)
    };
  });
  return { ok: true, thresholds: { device: devMin, ip: ipMin }, rows };
}

module.exports = { importRedemptions, importDevices, riskReport, excludeUsers, restoreUser, applyScores, codeLeaderboard };
