'use strict';
const crypto = require('crypto');
const { makeToken, verifyToken } = require('./util');

// 自托管算术图形验证码：生成 SVG + 无状态签名令牌，不依赖任何外部服务
function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function makeCaptcha(secret) {
  const a = rnd(1, 9), b = rnd(1, 9);
  const plus = Math.random() < 0.6;
  const question = plus ? `${a} + ${b}` : `${Math.max(a, b)} - ${Math.min(a, b)}`;
  const answer = plus ? a + b : Math.abs(a - b);

  const chars = (question + ' = ?').split('');
  let x = 14;
  let glyphs = '';
  for (const ch of chars) {
    const rot = rnd(-18, 18), y = rnd(24, 32);
    glyphs += `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" font-size="${rnd(19, 23)}" font-family="Menlo,Consolas,monospace" fill="#111213">${ch}</text>`;
    x += ch === ' ' ? 8 : 16;
  }
  let noise = '';
  for (let i = 0; i < 4; i++) {
    noise += `<path d="M${rnd(0, 30)} ${rnd(5, 45)} Q ${rnd(50, 110)} ${rnd(0, 50)} ${rnd(130, 170)} ${rnd(5, 45)}" stroke="#00B6D7" stroke-opacity="0.35" fill="none" stroke-width="1.2"/>`;
  }
  for (let i = 0; i < 24; i++) {
    noise += `<circle cx="${rnd(0, 170)}" cy="${rnd(0, 50)}" r="1" fill="#FFA73C" fill-opacity="0.5"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="170" height="50" viewBox="0 0 170 50"><rect width="170" height="50" rx="6" fill="#f7f7f7"/>${noise}${glyphs}</svg>`;

  const answerHash = crypto.createHash('sha256').update('cap:' + answer).digest('hex');
  const token = makeToken({ t: 'captcha', h: answerHash }, secret, 5 * 60 * 1000); // 5分钟有效
  return { svg, token };
}

function verifyCaptcha(token, answer, secret) {
  const payload = verifyToken(token, secret);
  if (!payload || payload.t !== 'captcha') return false;
  const n = parseInt(String(answer).trim(), 10);
  if (Number.isNaN(n)) return false;
  const h = crypto.createHash('sha256').update('cap:' + n).digest('hex');
  return h === payload.h;
}

module.exports = { makeCaptcha, verifyCaptcha };
