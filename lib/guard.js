'use strict';
// 频率限制 + 阶梯锁定 + 验证码一次性消费（单进程内存实现）
const { getSetting } = require('./db');

const fails = new Map();   // key -> { count, step, lockUntil }
const quota = new Map();   // key -> [timestamps]
const usedTokens = new Map(); // captcha token -> expireAt，防止同一验证码重放

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of fails) if (v.lockUntil < now && v.count === 0) fails.delete(k);
  for (const [k, arr] of quota) { const kept = arr.filter(t => now - t < 3600_000); kept.length ? quota.set(k, kept) : quota.delete(k); }
  for (const [k, exp] of usedTokens) if (exp < now) usedTokens.delete(k);
}, 10 * 60 * 1000).unref();

function lockSteps() {
  return getSetting('lock_steps').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0);
}

// 返回 null 表示未锁定；否则返回剩余秒数
function lockedFor(key) {
  const rec = fails.get(key);
  if (!rec) return null;
  const left = rec.lockUntil - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : null;
}

function recordFail(key) {
  const threshold = parseInt(getSetting('fail_threshold'), 10) || 0;
  if (threshold <= 0) return; // 0=不限制，不触发锁定
  const steps = lockSteps();
  const rec = fails.get(key) || { count: 0, step: 0, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= threshold) {
    const minutes = steps[Math.min(rec.step, steps.length - 1)] || 15;
    rec.lockUntil = Date.now() + minutes * 60_000;
    rec.step += 1;
    rec.count = 0;
  }
  fails.set(key, rec);
}

function recordSuccess(key) {
  const rec = fails.get(key);
  if (rec) { rec.count = 0; fails.set(key, rec); }
}

// 每小时配额，超出返回 false（limit ≤ 0 = 不限制）
function checkQuota(key, limit) {
  if (!limit || limit <= 0) return true;
  const now = Date.now();
  const arr = (quota.get(key) || []).filter(t => now - t < 3600_000);
  if (arr.length >= limit) { quota.set(key, arr); return false; }
  arr.push(now);
  quota.set(key, arr);
  return true;
}

// 验证码令牌只能用一次
function consumeToken(token) {
  if (usedTokens.has(token)) return false;
  usedTokens.set(token, Date.now() + 6 * 60_000);
  return true;
}

module.exports = { lockedFor, recordFail, recordSuccess, checkQuota, consumeToken };
