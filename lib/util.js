'use strict';
const crypto = require('crypto');

function hmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

// 无状态签名令牌：payload(JSON) + 过期时间 + HMAC
function makeToken(payload, secret, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  return body + '.' + hmac(body, secret);
}

function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const expect = hmac(body, secret);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function readJson(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendCsv(res, filename, content) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  });
  res.end('﻿' + content); // BOM 让 Excel 正确识别中文
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// 时间统一按北京时区（Asia/Shanghai）计算，不依赖容器系统时区。
// 用 Intl（Node 自带 ICU，Alpine 镜像无 tzdata 也可用），避免 UTC 容器把活动时间/榜单刷新算错8小时。
const TZ = 'Asia/Shanghai';
function beijingParts(d = new Date()) {
  const out = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d)) out[part.type] = part.value;
  return out;
}
// 北京日期 YYYY-MM-DD
function todayStr(d = new Date()) {
  const p = beijingParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}
// 北京时刻 HH:MM
function nowHM(d = new Date()) {
  const p = beijingParts(d);
  return `${p.hour}:${p.minute}`;
}
// 北京完整时间戳 YYYY-MM-DD HH:MM:SS（用于日志/展示）
function nowStr(d = new Date()) {
  const p = beijingParts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const XHS_RE = /^[A-Za-z0-9_.\-]{6,15}$/;

module.exports = { hmac, makeToken, verifyToken, readJson, send, sendCsv, clientIp, parseCookies, todayStr, nowHM, nowStr, UUID_RE, XHS_RE };
