'use strict';
const fs = require('fs');
const path = require('path');
const { getDb, getSetting, claimedCount, log } = require('../lib/db');
const { makeToken, verifyToken, readJson, send, clientIp, todayStr, nowStr, UUID_RE, XHS_RE } = require('../lib/util');
const { makeCaptcha, verifyCaptcha } = require('../lib/captcha');
const guard = require('../lib/guard');
const { latestSnapshotDate, assignPendingCodes } = require('../lib/snapshot');
const { activityPhase } = require('../lib/phase');
const rewards = require('../lib/rewards');

let bannedWords = [];
function loadBannedWords(baseDir) {
  try {
    bannedWords = fs.readFileSync(path.join(baseDir, 'banned-words.txt'), 'utf8')
      .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
      .map(s => s.toLowerCase());
  } catch { bannedWords = []; }
}

function hitBannedWord(nickname) {
  const low = nickname.toLowerCase();
  return bannedWords.find(w => low.includes(w)) || null;
}


function tiers() {
  return rewards.milestones();
}

// 取某 UID 当前的邀请码（未发放为 null）
function participantCode(uid) {
  const r = getDb().prepare('SELECT code FROM participants WHERE uid=? AND deleted_at IS NULL').get(uid);
  return r ? r.code : null;
}

// 校验验证码：通过返回 null，失败返回错误消息
function checkCaptcha(body, secret, failKey) {
  if (!body.captchaToken || !guard.consumeToken(body.captchaToken)) return '验证码已失效，请刷新后重试';
  if (!verifyCaptcha(body.captchaToken, body.captchaAnswer, secret)) {
    guard.recordFail(failKey);
    return '验证码错误，请重试';
  }
  return null;
}

function lockMsg(seconds) {
  const m = Math.ceil(seconds / 60);
  return `尝试次数过多，请 ${m} 分钟后再试`;
}

// 身份验证成功后签发的免验证码查询令牌（存于用户浏览器，有效期30天）
const RANK_TOKEN_TTL = 30 * 24 * 3600 * 1000;
function issueRankToken(uid, secret) {
  return makeToken({ t: 'rank', uid }, secret, RANK_TOKEN_TTL);
}

async function handle(req, res, url, config) {
  const db = getDb();
  const secret = config.secret;
  const ip = clientIp(req);

  // ---- 活动元信息（登记页初始化用） ----
  if (url.pathname === '/api/meta' && req.method === 'GET') {
    const capacity = parseInt(getSetting('capacity'), 10);
    const claimed = claimedCount();
    return send(res, 200, {
      ok: true,
      phase: activityPhase(),
      full: claimed >= capacity,
      remaining: Math.max(0, capacity - claimed),
      snapshotTime: getSetting('snapshot_time'),
      tiers: tiers(),
      rankPrizes: rewards.rankPrizes(),
      heroTitle: getSetting('hero_title'),
      heroSlogan: getSetting('hero_slogan')
    });
  }

  // ---- 图形验证码 ----
  if (url.pathname === '/api/captcha' && req.method === 'GET') {
    if (!guard.checkQuota('cap:' + ip, 60)) return send(res, 429, { ok: false, msg: '请求过于频繁，请稍后再试' });
    const { svg, token } = makeCaptcha(secret);
    return send(res, 200, { ok: true, svg, token });
  }

  // ---- 第一步：提交报名信息，校验后返回确认令牌 ----
  if (url.pathname === '/api/register' && req.method === 'POST') {
    const failKey = 'reg:' + ip;
    const locked = guard.lockedFor(failKey);
    if (locked) return send(res, 429, { ok: false, msg: lockMsg(locked) });
    if (!guard.checkQuota('ip:' + ip, parseInt(getSetting('ip_limit_hour'), 10)))
      return send(res, 429, { ok: false, msg: '请求过于频繁，请稍后再试' });

    const body = await readJson(req);
    const capErr = checkCaptcha(body, secret, failKey);
    if (capErr) return send(res, 400, { ok: false, msg: capErr });

    const phase = activityPhase();
    // 未开始也允许报名（开始前可先报名领码，前台在开始后才展示邀请码）；仅结束后拦截
    if (phase === 'ended') return send(res, 400, { ok: false, msg: '活动已结束，感谢关注' });

    const uid = String(body.uid || '').trim().toLowerCase();
    if (!UUID_RE.test(uid)) return send(res, 400, { ok: false, msg: '用户ID格式不正确，请到App「设置-关于」页复制完整的用户ID' });
    if (body.agree !== true) return send(res, 400, { ok: false, msg: '请先阅读并同意活动规则' });

    if (db.prepare('SELECT 1 FROM participants WHERE uid=?').get(uid)) return send(res, 400, { ok: false, msg: '该用户ID已参与过本次活动，请点击右上角「登录」' });

    const capacity = parseInt(getSetting('capacity'), 10);
    if (claimedCount() >= capacity) return send(res, 400, { ok: false, msg: '报名人数已满，请关注下次活动，谢谢！' });

    const confirmToken = makeToken({ t: 'confirm', uid }, secret, 10 * 60 * 1000);
    return send(res, 200, { ok: true, confirmToken, review: { uid } });
  }

  // ---- 第二步：确认报名（只登记、暂不发码；活动进行中才按报名顺序发码） ----
  if (url.pathname === '/api/claim' && req.method === 'POST') {
    const body = await readJson(req);
    const payload = verifyToken(body.confirmToken, secret);
    if (!payload || payload.t !== 'confirm') return send(res, 400, { ok: false, msg: '确认信息已过期，请重新填写报名信息' });
    const { uid } = payload;

    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT 1 FROM participants WHERE uid=? AND deleted_at IS NULL').get(uid)) {
        db.exec('ROLLBACK');
        return send(res, 400, { ok: false, msg: '该用户ID已参与过本次活动' });
      }
      const capacity = parseInt(getSetting('capacity'), 10);
      if (claimedCount() >= capacity) {
        db.exec('ROLLBACK');
        return send(res, 400, { ok: false, msg: '报名人数已满，请关注下次活动，谢谢！' });
      }
      db.prepare('INSERT INTO participants(uid) VALUES(?)').run(uid); // 只登记报名，邀请码稍后按顺序发放
      db.exec('COMMIT');
      log('register', `UID ${uid} 报名成功（按序等待发码）`);
    } catch (e) {
      db.exec('ROLLBACK');
      if (String(e.message).includes('UNIQUE')) return send(res, 400, { ok: false, msg: '该用户ID已参与过本次活动' });
      throw e;
    }
    assignPendingCodes();                        // 活动进行中：按报名顺序发码（含本次）
    const code = participantCode(uid);
    const phase = activityPhase();
    const reveal = phase !== 'not_started' && !!code;
    return send(res, 200, { ok: true, code: reveal ? code : null, pendingReveal: !reveal, rankToken: issueRankToken(uid, secret) });
  }

  // ---- 登录 / 找回（只凭 UID；UID 是 UUID 难以枚举，验证码防脚本） ----
  if (url.pathname === '/api/recover' && req.method === 'POST') {
    const failKey = 'rec:' + ip;
    const locked = guard.lockedFor(failKey);
    if (locked) return send(res, 429, { ok: false, msg: lockMsg(locked) });

    const body = await readJson(req);
    const capErr = checkCaptcha(body, secret, failKey);
    if (capErr) return send(res, 400, { ok: false, msg: capErr });

    const uid = String(body.uid || '').trim().toLowerCase();
    const row = db.prepare('SELECT nickname FROM participants WHERE uid=? AND deleted_at IS NULL').get(uid);
    if (!row) {
      guard.recordFail(failKey);
      return send(res, 400, { ok: false, msg: '未找到该 UID 的报名记录，请核对 UID' });
    }
    guard.recordSuccess(failKey);
    assignPendingCodes();                        // 登录也触发按报名顺序发码
    const phase = activityPhase();
    const code = participantCode(uid);
    const reveal = phase !== 'not_started' && !!code;
    return send(res, 200, { ok: true, nickname: row.nickname, code: reveal ? code : null, pendingReveal: !reveal, phase, rankToken: issueRankToken(uid, secret) });
  }

  // ---- 报名/登录二合一（未开始页单按钮用）：没报过名→登记报名；报过名→登录 ----
  if (url.pathname === '/api/join' && req.method === 'POST') {
    const failKey = 'join:' + ip;
    const locked = guard.lockedFor(failKey);
    if (locked) return send(res, 429, { ok: false, msg: lockMsg(locked) });
    const body = await readJson(req);
    const capErr = checkCaptcha(body, secret, failKey);
    if (capErr) return send(res, 400, { ok: false, msg: capErr });

    const phase = activityPhase();
    if (phase === 'ended') return send(res, 400, { ok: false, msg: '活动已结束，感谢关注' });
    const uid = String(body.uid || '').trim().toLowerCase();
    if (!UUID_RE.test(uid)) return send(res, 400, { ok: false, msg: '用户ID格式不正确，请到App「设置-关于」页复制完整的用户ID' });

    let mode;
    const existing = db.prepare('SELECT 1 FROM participants WHERE uid=? AND deleted_at IS NULL').get(uid);
    if (existing) { mode = 'login'; guard.recordSuccess(failKey); }
    else {
      const capacity = parseInt(getSetting('capacity'), 10);
      if (claimedCount() >= capacity) return send(res, 400, { ok: false, msg: '报名人数已满，请关注下次活动，谢谢！' });
      try { db.prepare('INSERT INTO participants(uid) VALUES(?)').run(uid); } // 只登记，暂不发码
      catch (e) { if (!String(e.message).includes('UNIQUE')) throw e; }
      log('register', `UID ${uid} 报名成功（按序等待发码）`);
      mode = 'register';
    }
    assignPendingCodes();                        // 活动进行中：按报名顺序发码
    const code = participantCode(uid);
    const reveal = phase !== 'not_started' && !!code;
    return send(res, 200, { ok: true, mode, phase, code: reveal ? code : null, pendingReveal: !reveal, rankToken: issueRankToken(uid, secret) });
  }

  // ---- 排行榜（前20，来自最近一次快照） ----
  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const snapDate = latestSnapshotDate();
    const note = getSetting('update_note') || '每小时更新';
    const prizeList = rewards.rankPrizes();
    if (!snapDate) {
      return send(res, 200, { ok: true, hasData: false, note, tiers: tiers(), rankPrizes: prizeList });
    }
    const rows = db.prepare('SELECT nickname, score, rank, code FROM snapshots WHERE snap_date=? ORDER BY rank LIMIT 10').all(snapDate);
    const top = rows.map(r => ({ ...r, prize: rewards.prizeForRank(r.rank, prizeList) }));
    return send(res, 200, { ok: true, hasData: true, snapDate, snapAt: getSetting('last_snapshot_at'), top, note, tiers: tiers(), rankPrizes: prizeList });
  }

  // ---- 查询我的排名（免验证码令牌，或 UID+小红书号+验证码 验证身份） ----
  if (url.pathname === '/api/myrank' && req.method === 'POST') {
    const body = await readJson(req);
    let p = null;
    let rankToken;

    const tokenPayload = body.rankToken ? verifyToken(body.rankToken, secret) : null;
    if (tokenPayload && tokenPayload.t === 'rank') {
      // 令牌路径：领码/找回/手动查询时已验证过身份，免验证码
      p = db.prepare('SELECT id, uid, nickname, status, code FROM participants WHERE uid=? AND deleted_at IS NULL').get(tokenPayload.uid);
      if (!p) return send(res, 401, { ok: false, needAuth: true, msg: '登录状态已失效，请重新查询' });
      rankToken = body.rankToken;
    } else if (body.rankToken) {
      return send(res, 401, { ok: false, needAuth: true, msg: '登录状态已过期，请重新查询' });
    } else {
      // 手动路径：只凭 UID + 验证码
      const failKey = 'rank:' + ip;
      const locked = guard.lockedFor(failKey);
      if (locked) return send(res, 429, { ok: false, msg: lockMsg(locked) });
      const capErr = checkCaptcha(body, secret, failKey);
      if (capErr) return send(res, 400, { ok: false, msg: capErr });

      const uid = String(body.uid || '').trim().toLowerCase();
      p = db.prepare("SELECT id, uid, nickname, status, code FROM participants WHERE uid=? AND deleted_at IS NULL").get(uid);
      if (!p) {
        guard.recordFail(failKey);
        return send(res, 400, { ok: false, msg: '未找到该 UID 的报名记录，请核对 UID' });
      }
      guard.recordSuccess(failKey);
      if (!guard.checkQuota('rank:' + uid, parseInt(getSetting('query_limit_hour'), 10)))
        return send(res, 429, { ok: false, msg: '本小时查询次数已用完，请稍后再来' });
      rankToken = issueRankToken(uid, secret); // 手动查询成功后同样签发令牌，下次免输入
    }

    assignPendingCodes();                    // 登录/查战绩也触发按报名顺序发码
    const myCode = participantCode(p.uid);
    const phase = activityPhase();
    // 活动未开始：报名成功，但邀请码开始后才发放、也没有排行数据
    if (phase === 'not_started') {
      return send(res, 200, {
        ok: true, hasData: false, phase, code: null, pendingReveal: true, rankToken,
        msg: '报名成功！邀请码将在活动开始后按报名顺序发放，开始后再来登录即可查看。'
      });
    }
    const snapDate = latestSnapshotDate();
    let entry = null;
    if (snapDate) entry = db.prepare("SELECT score, rank FROM snapshots WHERE snap_date=? AND entry_type='p' AND ref_id=?").get(snapDate, p.id);
    if (!entry) {
      return send(res, 200, {
        ok: true, hasData: false, phase, nickname: p.nickname, code: myCode, pendingReveal: !myCode, rankToken,
        msg: myCode ? `数据${getSetting('update_note') || '每小时更新'}，请耐心等待` : '报名成功！邀请码将按报名顺序发放，请稍后再来查看。'
      });
    }
    const tierList = tiers().map(t => ({ ...t, gap: Math.max(0, t.score - entry.score), reached: entry.score >= t.score }));
    // 不可叠加：进入名次奖区间则只发名次奖；否则发达标奖最高完成一档
    const rankPrize = rewards.prizeForRank(entry.rank);
    const reachedMilestone = tierList.some(t => t.reached);
    return send(res, 200, { ok: true, hasData: true, phase, nickname: p.nickname, code: myCode, score: entry.score, rank: entry.rank, snapDate, snapAt: getSetting('last_snapshot_at') || snapDate, tiers: tierList, rankPrize, hasReward: !!rankPrize || reachedMilestone, rankToken });
  }

  // ---- 中奖者填写领奖信息（登录态 rankToken 鉴权） ----
  if (url.pathname === '/api/winner-info' && req.method === 'POST') {
    const body = await readJson(req);
    const payload = body.rankToken ? verifyToken(body.rankToken, secret) : null;
    if (!payload || payload.t !== 'rank') return send(res, 401, { ok: false, needAuth: true, msg: '请先登录再填写领奖信息' });
    const p = db.prepare('SELECT id FROM participants WHERE uid=? AND deleted_at IS NULL').get(payload.uid);
    if (!p) return send(res, 404, { ok: false, msg: '未找到你的报名记录' });

    // 判断当前是否有奖、是否前十（前十=有名次奖，需填收件信息）
    const snapDate = latestSnapshotDate();
    const entry = snapDate ? db.prepare("SELECT score, rank FROM snapshots WHERE snap_date=? AND entry_type='p' AND ref_id=?").get(snapDate, p.id) : null;
    const rankPrize = entry ? rewards.prizeForRank(entry.rank) : null;
    const reachedMilestone = entry ? rewards.milestones().some(m => entry.score >= m.score) : false;
    if (!rankPrize && !reachedMilestone) return send(res, 400, { ok: false, msg: '您当前没有可领取的奖励，请下次继续加油！' });
    const needShipping = !!rankPrize;

    const xhs = String(body.xhs || '').trim();
    if (!XHS_RE.test(xhs)) return send(res, 400, { ok: false, msg: '小红书号格式不正确（6-15位字母、数字或 _ . -）' });
    let name = '', phone = '', address = '';
    if (needShipping) {
      name = String(body.name || '').trim();
      phone = String(body.phone || '').trim();
      address = String(body.address || '').trim();
      if (name.length < 2 || name.length > 20) return send(res, 400, { ok: false, msg: '收件人姓名需为2-20个字符' });
      if (!/^\d{6,20}$/.test(phone)) return send(res, 400, { ok: false, msg: '联系电话格式不正确' });
      if (address.length < 5 || address.length > 120) return send(res, 400, { ok: false, msg: '收货地址需为5-120个字符' });
    }
    db.prepare("UPDATE participants SET xhs_id=?, recipient_name=?, phone=?, address=?, prize_info_at=datetime('now','localtime') WHERE id=?")
      .run(xhs, name, phone, address, p.id);
    log('winner_info', `UID ${payload.uid} 提交领奖信息（小红书号 ${xhs}${needShipping ? ' +收件信息' : ''}）`);
    return send(res, 200, { ok: true, msg: '领奖信息已提交，感谢！我们会在结算后与你联系。' });
  }

  return false; // 未匹配
}

module.exports = { handle, loadBannedWords };
