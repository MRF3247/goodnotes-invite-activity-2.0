'use strict';
const crypto = require('crypto');
const { getDb, getSetting, setSetting, allSettings, log, claimedCount } = require('../lib/db');
const { makeToken, verifyToken, readJson, send, sendCsv, parseCookies, clientIp, todayStr } = require('../lib/util');
const guard = require('../lib/guard');
const { runSnapshot, latestSnapshotDate, pullNow, publishPending, assignCodeForShadow, assignPendingCodes } = require('../lib/snapshot');
const { pullRedemptions } = require('../lib/apiPull');
const rewards = require('../lib/rewards');
const { parseCsv, applyActivations } = require('../lib/sync');
const risk = require('../lib/risk');

const SESSION_TTL = 12 * 60 * 60 * 1000; // 12小时

function isAuthed(req, secret) {
  const cookies = parseCookies(req);
  const payload = verifyToken(cookies.gn_admin || '', secret);
  return payload && payload.t === 'admin';
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function handle(req, res, url, config) {
  const db = getDb();
  const secret = config.secret;
  const p = url.pathname;
  if (!p.startsWith('/api/admin/')) return false;

  // ---- 登录（唯一不需要会话的接口） ----
  if (p === '/api/admin/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const locked = guard.lockedFor('adm:' + ip);
    if (locked) return send(res, 429, { ok: false, msg: `尝试次数过多，请 ${Math.ceil(locked / 60)} 分钟后再试` });
    const body = await readJson(req);
    const given = Buffer.from(String(body.token || ''));
    const expect = Buffer.from(config.adminToken);
    const ok = given.length === expect.length && crypto.timingSafeEqual(given, expect);
    if (!ok) {
      guard.recordFail('adm:' + ip);
      log('admin_login_fail', `IP ${ip} 登录失败`);
      return send(res, 401, { ok: false, msg: '口令错误' });
    }
    guard.recordSuccess('adm:' + ip);
    const session = makeToken({ t: 'admin' }, secret, SESSION_TTL);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `gn_admin=${encodeURIComponent(session)}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Strict`
    });
    log('admin_login', `IP ${ip} 登录成功`);
    return res.end(JSON.stringify({ ok: true }));
  }

  if (!isAuthed(req, secret)) return send(res, 401, { ok: false, msg: '未登录或会话已过期', needLogin: true });

  // ---- 总览 ----
  if (p === '/api/admin/overview' && req.method === 'GET') {
    const today = todayStr(); // 北京日期 YYYY-MM-DD
    const codesTotal = db.prepare('SELECT COUNT(*) c FROM codes').get().c;
    const codesAssigned = db.prepare('SELECT COUNT(*) c FROM codes WHERE assigned_to IS NOT NULL').get().c;
    // 当前真正可分配 = 未分配且在生效期内（与领码逻辑同一把尺子）
    const codesAvailable = db.prepare(`
      SELECT COUNT(*) c FROM codes
      WHERE assigned_to IS NULL
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_to IS NULL OR valid_to >= ?)
    `).get(today, today).c;
    return send(res, 200, {
      ok: true,
      claimed: claimedCount(),
      capacity: parseInt(getSetting('capacity'), 10),
      codesTotal, codesAssigned, codesAvailable,
      codesFree: codesTotal - codesAssigned,
      lastSnapshotAt: getSetting('last_snapshot_at') || '尚未生成',
      latestSnapDate: latestSnapshotDate(),
      activityStatus: getSetting('activity_status') || 'running',
      disqualified: db.prepare("SELECT COUNT(*) c FROM participants WHERE status='disqualified'").get().c
    });
  }

  // ---- 邀请码CSV模板下载（单列：邀请码） ----
  if (p === '/api/admin/codes/template' && req.method === 'GET') {
    return sendCsv(res, '邀请码导入模板.csv', '邀请码\nAB12CD34\nEF56GH78\n');
  }

  // ---- 导入邀请码（只取第一列，生效期由后端系统管理，本系统不设日期） ----
  if (p === '/api/admin/codes/import' && req.method === 'POST') {
    const body = await readJson(req);
    const rows = parseCsv(body.csv || '');
    let added = 0, skipped = 0;
    const ins = db.prepare('INSERT OR IGNORE INTO codes(code) VALUES(?)');
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const code = String(row[0] || '').trim();
        if (!code || code === '邀请码' || code.toLowerCase() === 'code') continue; // 跳过表头/空行
        const r = ins.run(code);
        r.changes ? added++ : skipped++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    log('codes_import', `导入邀请码：新增 ${added}，重复跳过 ${skipped}`);
    return send(res, 200, { ok: true, added, skipped });
  }

  // ---- 应急：下载当前邀请码与邀请人数（改完可上传覆盖，也可作手动备份） ----
  if (p === '/api/admin/sync/export' && req.method === 'GET') {
    const rows = db.prepare(`
      SELECT c.code, c.activations, p.nickname
      FROM codes c LEFT JOIN participants p ON p.id = c.assigned_to
      WHERE c.assigned_to IS NOT NULL
      ORDER BY c.activations DESC
    `).all();
    const csv = '邀请码,邀请人数,参赛昵称(仅供核对不会导入)\n'
      + rows.map(r => [r.code, r.activations, r.nickname].map(csvEscape).join(',')).join('\n') + '\n';
    log('sync_export', `下载当前邀请人数表 ${rows.length} 条`);
    return sendCsv(res, `邀请人数-${todayStr()}.csv`, csv);
  }

  // ---- 应急：手动同步激活次数（CSV：邀请码,激活次数 —— 绝对值覆盖） ----
  if (p === '/api/admin/sync/import' && req.method === 'POST') {
    const body = await readJson(req);
    const { updated, unknown } = applyActivations(body.csv || '');
    log('sync_import', `手动同步激活数据：更新 ${updated} 个邀请码` + (unknown.length ? `，未匹配 ${unknown.length} 个` : ''));
    return send(res, 200, { ok: true, updated, unknown });
  }

  // ---- 风控审核流程 ----
  if (p === '/api/admin/risk/import' && req.method === 'POST') {
    const body = await readJson(req);
    const r = body.table === 'devices' ? risk.importDevices(body.csv || '') : risk.importRedemptions(body.csv || '');
    return send(res, r.ok ? 200 : 400, r);
  }
  if (p === '/api/admin/risk/report' && req.method === 'GET') {
    const r = risk.riskReport();
    return send(res, r.ok ? 200 : 400, r);
  }
  if (p === '/api/admin/risk/exclude' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.restore) {
      const ok = risk.restoreUser(body.restore);
      return send(res, ok ? 200 : 404, { ok, msg: ok ? '已恢复' : 'UID不存在' });
    }
    const reason = String(body.reason || '').trim();
    if (!reason) return send(res, 400, { ok: false, msg: '请填写剔除原因（会记入操作日志）' });
    const ids = String(body.userIds || '').split(/[\s,，;；]+/).filter(Boolean);
    if (!ids.length) return send(res, 400, { ok: false, msg: '请填写要剔除的UID' });
    const n = risk.excludeUsers(ids, reason);
    return send(res, 200, { ok: true, count: n });
  }
  if (p === '/api/admin/risk/publish' && req.method === 'POST') {
    const r = risk.applyScores();
    if (!r.ok) return send(res, 400, r);
    r.snapshotCount = runSnapshot();
    setSetting('snapshot_done_date', todayStr());
    return send(res, 200, r);
  }

  // ---- 查询（邀请码 / 小红书号 / UID / 昵称） ----
  if (p === '/api/admin/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return send(res, 400, { ok: false, msg: '请输入查询内容' });
    const like = `%${q}%`;
    const rows = db.prepare(`
      SELECT p.id, p.uid, p.xhs_id, p.nickname, p.status, p.note, p.created_at,
             c.code, c.valid_from, c.valid_to, c.activations, c.manual_delta,
             (c.activations + c.manual_delta) AS score, c.synced_at
      FROM participants p LEFT JOIN codes c ON c.assigned_to = p.id
      WHERE p.uid LIKE ? OR p.xhs_id LIKE ? OR p.nickname LIKE ? OR c.code LIKE ?
      ORDER BY p.id DESC LIMIT 50
    `).all(like, like, like, like);
    return send(res, 200, { ok: true, rows });
  }

  // ---- 人工修正积分 ----
  if (p === '/api/admin/adjust' && req.method === 'POST') {
    const body = await readJson(req);
    const code = String(body.code || '').trim();
    const delta = parseInt(body.delta, 10);
    const reason = String(body.reason || '').trim();
    if (!code || Number.isNaN(delta)) return send(res, 400, { ok: false, msg: '参数不完整' });
    if (!reason) return send(res, 400, { ok: false, msg: '请填写修正原因（会记入操作日志）' });
    const r = db.prepare('UPDATE codes SET manual_delta = manual_delta + ? WHERE code=?').run(delta, code);
    if (!r.changes) return send(res, 404, { ok: false, msg: '邀请码不存在' });
    log('adjust', `邀请码 ${code} 邀请人数修正 ${delta > 0 ? '+' : ''}${delta}，原因：${reason}`);
    return send(res, 200, { ok: true });
  }

  // ---- 取消/恢复参赛资格 ----
  if (p === '/api/admin/disqualify' && req.method === 'POST') {
    const body = await readJson(req);
    const id = parseInt(body.id, 10);
    const restore = body.restore === true;
    const reason = String(body.reason || '').trim();
    if (!id || (!restore && !reason)) return send(res, 400, { ok: false, msg: '请填写原因（会记入操作日志）' });
    const row = db.prepare('SELECT nickname FROM participants WHERE id=?').get(id);
    if (!row) return send(res, 404, { ok: false, msg: '用户不存在' });
    db.prepare('UPDATE participants SET status=?, note=? WHERE id=?')
      .run(restore ? 'active' : 'disqualified', restore ? '' : reason, id);
    log(restore ? 'requalify' : 'disqualify', `用户「${row.nickname}」${restore ? '恢复参赛资格' : '取消参赛资格，原因：' + reason}`);
    return send(res, 200, { ok: true });
  }

  // ---- 激励号管理 ----
  if (p === '/api/admin/shadows' && req.method === 'GET') {
    return send(res, 200, { ok: true, rows: db.prepare('SELECT * FROM shadows ORDER BY id').all() });
  }
  if (p === '/api/admin/shadows' && req.method === 'POST') {
    const body = await readJson(req);
    const nickname = String(body.nickname || '').trim();
    if (nickname.length < 2 || nickname.length > 20) return send(res, 400, { ok: false, msg: '昵称需为2-20个字符' });
    if (db.prepare('SELECT 1 FROM participants WHERE nickname=?').get(nickname) ||
        db.prepare('SELECT 1 FROM shadows WHERE nickname=?').get(nickname))
      return send(res, 400, { ok: false, msg: '该昵称已存在' });
    const score = Math.max(0, parseInt(body.score, 10) || 0);
    const auto = body.auto === false ? 0 : 1;
    // 激励号需占用一个真实邀请码（用于公开榜展示、且可被真实兑换）；码池不足则拒绝创建
    db.exec('BEGIN IMMEDIATE');
    try {
      const info = db.prepare('INSERT INTO shadows(nickname, score, auto) VALUES(?,?,?)').run(nickname, score, auto);
      const code = assignCodeForShadow(info.lastInsertRowid);
      if (!code) {
        db.exec('ROLLBACK');
        return send(res, 400, { ok: false, msg: '码池已无可分配的邀请码，请先上传更多邀请码再创建激励号' });
      }
      db.exec('COMMIT');
      log('shadow_add', `新增激励号「${nickname}」初始积分 ${score}，自动配分：${auto ? '开' : '关'}，占用邀请码 ${code}`);
      return send(res, 200, { ok: true, code });
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  if (p === '/api/admin/shadows/update' && req.method === 'POST') {
    const body = await readJson(req);
    const id = parseInt(body.id, 10);
    const row = db.prepare('SELECT nickname FROM shadows WHERE id=?').get(id);
    if (!row) return send(res, 404, { ok: false, msg: '激励号不存在' });
    if (body.remove === true) {
      // 释放它占用的邀请码，回到可分配池（激活数保留在码上，管理员知悉）
      const freed = db.prepare('UPDATE codes SET shadow_id=NULL WHERE shadow_id=?').run(id).changes;
      db.prepare('DELETE FROM shadows WHERE id=?').run(id);
      log('shadow_del', `删除激励号「${row.nickname}」` + (freed ? `，释放邀请码回码池` : ''));
      return send(res, 200, { ok: true });
    }
    if (typeof body.score === 'number') {
      db.prepare('UPDATE shadows SET score=? WHERE id=?').run(Math.max(0, Math.floor(body.score)), id);
      log('shadow_score', `激励号「${row.nickname}」积分手动设为 ${body.score}`);
    }
    if (typeof body.auto === 'boolean') {
      db.prepare('UPDATE shadows SET auto=? WHERE id=?').run(body.auto ? 1 : 0, id);
      log('shadow_auto_flag', `激励号「${row.nickname}」自动配分：${body.auto ? '开' : '关'}`);
    }
    return send(res, 200, { ok: true });
  }

  // ---- 设置读写 ----
  if (p === '/api/admin/settings' && req.method === 'GET') {
    return send(res, 200, { ok: true, settings: allSettings() });
  }
  if (p === '/api/admin/settings' && req.method === 'POST') {
    const body = await readJson(req);
    const changed = [];
    for (const [k, v] of Object.entries(body.settings || {})) {
      if (getSetting(k) !== String(v)) { setSetting(k, v); changed.push(k); }
    }
    if (changed.length) log('settings', `修改配置：${changed.join(', ')}`);
    if (changed.includes('activity_status') || changed.includes('activity_start') || changed.includes('activity_end')) assignPendingCodes(); // 活动转为进行中时按序发码
    return send(res, 200, { ok: true, changed });
  }

  // ---- 立即生成榜单 ----
  if (p === '/api/admin/snapshot/run' && req.method === 'POST') {
    const count = runSnapshot();
    return send(res, 200, { ok: true, count });
  }

  // ---- 榜单快照预览（完整排行、分页20/页、标注激励号）----
  if (p === '/api/admin/snapshot' && req.method === 'GET') {
    const snapDate = latestSnapshotDate();
    const snapAt = getSetting('last_snapshot_at') || snapDate || '';
    if (!snapDate) return send(res, 200, { ok: true, total: 0, page: 1, size: 20, snapAt, rows: [] });
    const size = 20;
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const total = db.prepare('SELECT COUNT(*) c FROM snapshots WHERE snap_date=?').get(snapDate).c;
    const rows = db.prepare('SELECT rank, code, nickname, score, entry_type FROM snapshots WHERE snap_date=? ORDER BY rank LIMIT ? OFFSET ?')
      .all(snapDate, size, (page - 1) * size)
      .map(r => ({ rank: r.rank, code: r.code, nickname: r.nickname, score: r.score, isShadow: r.entry_type === 's' }));
    return send(res, 200, { ok: true, total, page, size, snapAt, rows });
  }

  // ==== 2.0 活动管理 ====
  // 立即从后端接口拉取（导入/刷新 batchId）：写入 pending + 明细
  if (p === '/api/admin/activity/pull' && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const r = await pullNow(config, { withDetail: body.withDetail !== false });
    return send(res, r.ok === false ? 400 : 200, r);
  }
  // 立即发布：把 pending 落到前台
  if (p === '/api/admin/activity/publish' && req.method === 'POST') {
    return send(res, 200, { ok: true, ...publishPending() });
  }
  // 邀请码清单（分页 20/页 + 系统内邀请码总数）
  if (p === '/api/admin/activity/codes' && req.method === 'GET') {
    const batchId = (url.searchParams.get('batchId') || '').trim();
    const where = batchId ? 'WHERE batch_id = ?' : '';
    const args = batchId ? [batchId] : [];
    const size = 20;
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const total = db.prepare(`SELECT COUNT(*) c FROM codes ${where}`).get(...args).c;
    const totalAll = db.prepare('SELECT COUNT(*) c FROM codes').get().c;
    const rows = db.prepare(`
      SELECT code, batch_id, activations, pending, manual_delta, max_redemptions, synced_at
      FROM codes ${where} ORDER BY COALESCE(pending, activations) DESC LIMIT ? OFFSET ?
    `).all(...args, size, (page - 1) * size);
    const batches = db.prepare('SELECT batch_id, COUNT(*) codes, COALESCE(SUM(COALESCE(pending,activations)),0) redemptions FROM codes GROUP BY batch_id').all();
    return send(res, 200, { ok: true, rows, batches, total, totalAll, page, size });
  }
  // 单个码的兑换明细（IP/UID/设备/时间）
  if (p === '/api/admin/activity/code-detail' && req.method === 'GET') {
    const code = (url.searchParams.get('code') || '').trim();
    if (!code) return send(res, 400, { ok: false, msg: '缺少 code' });
    let rows = db.prepare('SELECT user_id, ip, device, redeemed_at FROM redemptions WHERE code=? ORDER BY redeemed_at').all(code);
    // 本地无明细时可选实时回源（withDetail 未跑过）
    if (!rows.length && url.searchParams.get('live') === '1') {
      try {
        const live = await pullRedemptions(config, code);
        rows = live.map(r => ({ user_id: r.user_id, ip: r.ip, device: r.device, redeemed_at: r.redeemed_at }));
      } catch (e) { return send(res, 200, { ok: true, rows: [], liveError: e.message }); }
    }
    return send(res, 200, { ok: true, rows });
  }
  // 后台兑换榜：按分数排序 + 逐码违规预警（同IP/同设备跨多账号）
  if (p === '/api/admin/activity/leaderboard' && req.method === 'GET') {
    return send(res, 200, risk.codeLeaderboard());
  }

  // ==== 账号管理 ====
  // 账号列表（分页20/页，含小红书号/收件信息/邀请码/邀请人数）
  if (p === '/api/admin/accounts' && req.method === 'GET') {
    const size = 20;
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const q = (url.searchParams.get('q') || '').trim();
    const like = `%${q}%`;
    const where = q ? "AND (p.uid LIKE ? OR p.xhs_id LIKE ? OR p.code LIKE ?)" : '';
    const args = q ? [like, like, like] : [];
    const total = db.prepare(`SELECT COUNT(*) c FROM participants p WHERE p.deleted_at IS NULL ${where}`).get(...args).c;
    const rows = db.prepare(`
      SELECT p.id, p.uid, p.xhs_id, p.recipient_name, p.phone, p.address, p.code, p.created_at,
             COALESCE(c.activations + c.manual_delta, 0) AS score
      FROM participants p LEFT JOIN codes c ON c.assigned_to = p.id
      WHERE p.deleted_at IS NULL ${where}
      ORDER BY p.id LIMIT ? OFFSET ?
    `).all(...args, size, (page - 1) * size);
    return send(res, 200, { ok: true, total, page, size, rows });
  }
  // 邀请码管理列表（分页，码+邀请人数+归属账号）
  if (p === '/api/admin/invite-codes' && req.method === 'GET') {
    const size = 20;
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const q = (url.searchParams.get('q') || '').trim();
    const onlyAssigned = url.searchParams.get('assigned') === '1';
    const conds = [];
    const args = [];
    if (q) { conds.push('c.code LIKE ?'); args.push(`%${q}%`); }
    if (onlyAssigned) conds.push('c.assigned_to IS NOT NULL');
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM codes c ${where}`).get(...args).c;
    const rows = db.prepare(`
      SELECT c.code, (c.activations + c.manual_delta) AS score, c.shadow_id,
             p.uid AS holder_uid, p.id AS holder_id
      FROM codes c LEFT JOIN participants p ON p.id = c.assigned_to AND p.deleted_at IS NULL
      ${where} ORDER BY c.assigned_to IS NULL, score DESC LIMIT ? OFFSET ?
    `).all(...args, size, (page - 1) * size);
    return send(res, 200, { ok: true, total, page, size, rows });
  }
  // 删除（软删，5天内可恢复）：kind=account 删账号 / kind=code 清除邀请码
  if (p === '/api/admin/delete' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.kind === 'account') {
      const pt = db.prepare('SELECT id, uid FROM participants WHERE id=? AND deleted_at IS NULL').get(parseInt(body.id, 10));
      if (!pt) return send(res, 404, { ok: false, msg: '账号不存在或已删除' });
      db.prepare("UPDATE participants SET deleted_at=datetime('now','localtime') WHERE id=?").run(pt.id);
      db.prepare('INSERT INTO deletions(kind, participant_id, label, payload) VALUES(?,?,?,?)').run('account', pt.id, pt.uid, '{}');
      log('delete_account', `软删除账号 UID ${pt.uid}（5天内可恢复）`);
      return send(res, 200, { ok: true });
    }
    if (body.kind === 'code') {
      const code = String(body.code || '').trim();
      const c = db.prepare('SELECT code, assigned_to, activations, manual_delta, pending FROM codes WHERE code=?').get(code);
      if (!c) return send(res, 404, { ok: false, msg: '邀请码不存在' });
      if (!c.assigned_to) return send(res, 400, { ok: false, msg: '该邀请码未绑定账号，无需清除' });
      const payload = JSON.stringify({ code: c.code, activations: c.activations, manual_delta: c.manual_delta, pending: c.pending });
      db.prepare('INSERT INTO deletions(kind, participant_id, label, payload) VALUES(?,?,?,?)').run('code', c.assigned_to, c.code, payload);
      db.prepare('UPDATE participants SET code=NULL WHERE id=?').run(c.assigned_to);
      db.prepare("UPDATE codes SET activations=0, manual_delta=0, pending=NULL WHERE code=?").run(code); // 暂扣：保留 assigned_to，不放回码池，便于恢复
      log('delete_code', `清除邀请码 ${code} 及其邀请人数（5天内可恢复）`);
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { ok: false, msg: '未知删除类型' });
  }
  // 回收站列表
  if (p === '/api/admin/deletions' && req.method === 'GET') {
    const rows = db.prepare("SELECT id, kind, label, deleted_at, CAST(julianday(deleted_at,'+5 days') - julianday('now','localtime') + 0.999 AS INT) AS days_left FROM deletions ORDER BY id DESC").all();
    return send(res, 200, { ok: true, rows });
  }
  // 恢复
  if (p === '/api/admin/restore' && req.method === 'POST') {
    const body = await readJson(req);
    const d = db.prepare('SELECT * FROM deletions WHERE id=?').get(parseInt(body.id, 10));
    if (!d) return send(res, 404, { ok: false, msg: '删除记录不存在或已到期清除' });
    if (d.kind === 'account') {
      db.prepare('UPDATE participants SET deleted_at=NULL WHERE id=?').run(d.participant_id);
    } else if (d.kind === 'code') {
      const pl = JSON.parse(d.payload || '{}');
      db.prepare('UPDATE participants SET code=? WHERE id=?').run(pl.code, d.participant_id);
      db.prepare('UPDATE codes SET activations=?, manual_delta=?, pending=? WHERE code=?').run(pl.activations || 0, pl.manual_delta || 0, pl.pending ?? null, pl.code);
    }
    db.prepare('DELETE FROM deletions WHERE id=?').run(d.id);
    log('restore', `恢复${d.kind === 'account' ? '账号' : '邀请码'}：${d.label}`);
    return send(res, 200, { ok: true });
  }

  // ---- 导出活动全量数据（按榜单排名，含激励号并标注；文件名带【严禁外传】）----
  if (p === '/api/admin/export' && req.method === 'GET') {
    const t = rewards.milestones();
    const snapDate = latestSnapshotDate();
    const snaps = snapDate
      ? db.prepare('SELECT rank, entry_type, ref_id, code, nickname, score FROM snapshots WHERE snap_date=? ORDER BY rank').all(snapDate)
      : [];
    const header = '排名(含激励号),类型,昵称,用户ID,小红书号,邀请码,邀请人数,名次奖(冲榜奖),达标奖(最高档),最终奖励(不可叠加·冲榜奖优先),收件人,电话,收货地址,领奖信息提交时间,备注';
    const lines = snaps.map(s => {
      const rp = rewards.prizeForRank(s.rank);
      const reached = [...t].reverse().find(x => s.score >= x.score);
      const rankPrizeText = rp ? `${rp.label ? rp.label + ' ' : ''}${rp.prize}` : '';
      const milestoneText = reached ? reached.name : '未达标';
      if (s.entry_type === 's') { // 激励号
        return [s.rank, '激励号', s.nickname ?? 'null', '', '', s.code, s.score, rankPrizeText || '—', milestoneText, '（激励号不发奖）', '', '', '', '', ''].map(csvEscape).join(',');
      }
      const pt = db.prepare('SELECT uid, xhs_id, nickname, recipient_name, phone, address, prize_info_at, note FROM participants WHERE id=?').get(s.ref_id) || {};
      const finalReward = rp ? rankPrizeText : (reached ? milestoneText : '未获奖');
      return [
        s.rank, '真实用户', (pt.nickname ?? 'null'), pt.uid || '', pt.xhs_id || '', s.code, s.score,
        rankPrizeText || '—', milestoneText, finalReward,
        pt.recipient_name || '', pt.phone || '', pt.address || '', pt.prize_info_at || '', pt.note || ''
      ].map(csvEscape).join(',');
    });
    log('export', `导出活动全量数据 ${snaps.length} 条（含激励号）`);
    return sendCsv(res, `活动数据【严禁外传】-${todayStr()}.csv`, header + '\n' + lines.join('\n') + '\n');
  }

  // ---- 操作日志 ----
  if (p === '/api/admin/logs' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 200').all();
    return send(res, 200, { ok: true, rows });
  }

  return send(res, 404, { ok: false, msg: '接口不存在' });
}

module.exports = { handle };
